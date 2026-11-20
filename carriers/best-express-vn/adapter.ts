import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { paused } from '../../core/runner/pause.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { BEST_VN, isBestNumber, parseBest, refusedVerification, type BestRegion } from './parser.js';
import { BestRotate } from './rotate.js';

export { BEST_VN, parseBest, type BestRegion } from './parser.js';
// BEST's verification service, which every country's tracker shares.
const CAPTCHA = 'https://captcha-sg.800best.com/api/captcha';
// The tracker page's client; the region adds the language the scans come in.
const CLIENT = { 'X-Auth-Type': 'WEB', 'Device-Type': 'X9-WEB' };
const INSTANCE = /^[A-Za-z0-9-]{8,80}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const ANSWER = /^\d{1,3}(?:\.\d{1,3})?$/;
// Answers and pictures per lookup. Each picture takes one answer. The solver knows most of the
// pictures BEST draws from; one it does not know is left unanswered and costs only a new picture.
const ANSWERS = 8;
const PICTURES = 16;
// Time one more picture needs: its instance, the picture, the match, the wait, the answer and the lookup.
const PICTURE_MS = 5_000;
// The service refuses an answer sent within a couple of seconds of its picture, as no person turns it that fast.
const SETTLE_MS = 3_000;
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export interface BestOptions { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveRotation?: Solver; settleMs?: number }

/** One country's BEST tracker, read past the picture its verification service asks to turn upright. */
export class BestTracker {
  private readonly rotate: BestRotate;
  constructor(private readonly region: BestRegion, private readonly options: BestOptions = {}) {
    this.rotate = new BestRotate(region.provider);
  }

  async fetch(raw: string, context: TrackingContext = {}) {
    const { region } = this, { provider, site, appKey } = region;
    const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
    if (!isBestNumber(number)) throw new InvalidInputError(provider, `${provider} waybills are letters and digits`);
    return runSteps({ carrier: region.carrier, budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(provider, remainingMs);
        return remaining;
      };
      const fetcher = this.options.fetcher ?? fetch;
      const request = async (url: string, accept: string, maxBytes: number, body?: { type: string; text: string }, extra: Record<string, string> = {}) => {
        const { response, bytes } = await fetchBounded(url, { signal, ...(body ? { method: 'POST', body: body.text } : {}),
          headers: { Accept: accept, Origin: site, Referer: `${site}/`, 'User-Agent': userAgentOf(this.options.userAgent),
            ...(body ? { 'Content-Type': body.type } : {}), ...extra } },
        { provider: provider, timeoutMs: left(), maxBytes, fetcher, allowHttpStatuses: [404, 410] });
        if (response.status !== 200) throw new TransportError(provider, `${provider} tracking is unavailable`, { status: response.status });
        return bytes;
      };
      const json = (bytes: Uint8Array) => {
        if (/^\s*</.test(decodeText(bytes.subarray(0, 256)))) throw new ChallengeError(provider, `${provider} answered with a web page instead of its reply`);
        return parseJsonBytes(bytes, provider);
      };
      const form = (fields: Record<string, string>) => ({ type: 'application/x-www-form-urlencoded', text: new URLSearchParams(fields).toString() });
      try {
        let refused = false, answers = 0;
        for (let picture = 0; picture < PICTURES && answers < ANSWERS; picture++) {
          if (picture && left() < PICTURE_MS) break;
          const started = json(await request(`${CAPTCHA}/init`, 'application/json, text/plain, */*', 4_096, form({ appKey, type: 'rotate_pic' })));
          const instance = isRecord(started) && started.code === '200' && isRecord(started.data) && started.data.type === 'rotate_pic'
            && !started.data.imageEncryption && typeof started.data.instanceId === 'string' ? started.data.instanceId : '';
          if (!INSTANCE.test(instance)) throw new SchemaError(provider, `${provider} returned no verification picture`);
          const image = await request(`${CAPTCHA}/resource?${new URLSearchParams({ t: String(Date.now()), source: 'web', appKey, instanceId: instance })}`,
            'image/avif,image/webp,image/*,*/*;q=0.8', 40_000);
          const drawn = performance.now();
          const answer = await (this.options.solveRotation ?? this.rotate.solve.bind(this.rotate))(image, signal);
          // A picture the solver does not know is not answered: the next one is cheaper than a refusal.
          if (!ANSWER.test(answer) || Number(answer) >= 360) continue;
          const wait = (this.options.settleMs ?? SETTLE_MS) - (performance.now() - drawn);
          if (wait > 0) {
            if (left() <= wait + 1_000) break;
            if (!await paused(wait, signal)) signal.throwIfAborted();
          }
          answers++;
          const verified = json(await request(`${CAPTCHA}/verify/first`, 'application/json, text/plain, */*', 4_096,
            form({ appKey, instanceId: instance, verifyReq: String(Math.round(Number(answer)) % 360) })));
          if (!isRecord(verified)) throw new SchemaError(provider, `${provider} returned an unreadable verification`);
          const pass = verified.success === true && isRecord(verified.data) ? verified.data : null;
          if (!pass) {
            // 5002 is a wrong turn; the instance takes no second answer.
            if (verified.code !== '5002') throw new ChallengeError(provider, refusedVerification(region));
            refused = true;
            continue;
          }
          const code = typeof pass.code === 'string' ? pass.code : '', validate = typeof pass.validate === 'string' ? pass.validate : '';
          if (!TOKEN.test(code) || !TOKEN.test(validate)) throw new SchemaError(provider, `${provider} returned an unreadable verification`);
          const reply = json(await request(`${site}/express-cc/express/expresslistinfo?${new URLSearchParams({ instanceId: instance, code, validate })}`,
            'application/json, text/plain, */*', 1_000_000, { type: 'application/json', text: JSON.stringify({ expressIds: [number] }) }, { ...CLIENT, ...region.language }));
          try {
            return parseBest(reply, number, region);
          } catch (error) {
            if (!(error instanceof ChallengeError) || error.message !== refusedVerification(region)) throw error;
            refused = true;
          }
        }
        throw new ChallengeError(provider, refused ? `${provider} refused every picture answer` : `${provider} pictures could not be matched`);
      } catch (error) {
        // Raw transport diagnostics can carry the verification's tokens.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
  close() { return this.rotate.close(); }
}

export class BestExpressVnTracker extends BestTracker {
  constructor(options: BestOptions = {}) { super(BEST_VN, options); }
}

/** The adapter for one country's BEST tracker. */
export const bestAdapter = (region: BestRegion): AdapterFactory => environment => {
  const tracker = new BestTracker(region, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: region.carrier, recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};

export const adapter: AdapterFactory = bestAdapter(BEST_VN);
