import { createCipheriv, createHash } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeBfeNumber, parseBfe, PROVIDER } from './parser.js';

const API = 'https://us-ec-gateway.bfeexpress.com/api/v1/trackings?lang=en-US';
const SITE = 'https://www.bfeexpress.com';
// The key the tracking page's script gives every visitor: it signs the request and encrypts the number.
const PAGE_KEY = 'Vnj25FYu3mIjbNUS'; // gitleaks:allow
// The service refuses a request signed a minute away from its clock, and gives its clock in the refusal.
const CLOCK_SKEW_MS = 20_000;

/**
 * The body the tracking page posts: the UTC clock to the hundredth of a second, signed with the page's key by MD5,
 * and the number encrypted by AES-256-CBC under that digest, with the page's key as its IV.
 */
export function bfeRequestBody(number: string, at: Date): { securityKey: string; securityValue: string } {
  const stamp = at.toISOString().replace(/\D/g, '').slice(0, 16);
  const digest = createHash('md5').update(stamp + PAGE_KEY).digest('hex');
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(digest, 'utf8'), Buffer.from(PAGE_KEY, 'utf8'));
  const value = Buffer.concat([cipher.update(number, 'utf8'), cipher.final()]).toString('hex');
  return { securityKey: digest + stamp.slice(-4), securityValue: value };
}

/** The service's clock in a refusal of the signature, when it is far from ours. */
function serviceClock(payload: unknown, sentAt: number): Date | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.Errors) || !payload.Errors.some(error => isRecord(error) && error.Message === 'Query illegal!')) return undefined;
  const clock = typeof payload.UtcDateTime === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(payload.UtcDateTime) ? Date.parse(payload.UtcDateTime) : NaN;
  return Number.isFinite(clock) && Math.abs(clock - sentAt) > CLOCK_SKEW_MS ? new Date(clock) : undefined;
}

export class BfeExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeBfeNumber(raw);
    const now = this.options.now ?? Date.now;
    return runSteps({ carrier: 'bfe-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const started = performance.now();
      const ask = async (at: number) => {
        signal.throwIfAborted();
        const { response, bytes } = await fetchBounded(API, { method: 'POST', signal,
          headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: SITE, Referer: `${SITE}/`,
            'User-Agent': userAgentOf(this.options.userAgent) },
          body: JSON.stringify(bfeRequestBody(number, new Date(at))),
        }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs - (performance.now() - started))), maxBytes: 1_000_000,
          allowHttpStatuses: [400], fetcher: this.options.fetcher });
        let payload: unknown;
        try { payload = parseJsonBytes(bytes, PROVIDER); }
        catch (cause) { throw new SchemaError(PROVIDER, 'BFE Express returned invalid tracking JSON', { cause }); }
        return { status: response.status, payload };
      };
      const sentAt = now();
      let reply = await ask(sentAt);
      // A refused signature from a clock that is off: signed again once on the service's clock.
      const clock = reply.status === 400 ? serviceClock(reply.payload, sentAt) : undefined;
      if (clock) reply = await ask(clock.getTime());
      if (reply.status !== 200) throw new SchemaError(PROVIDER, 'BFE Express refused the tracking page\'s request');
      return parseBfe(reply.payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new BfeExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'bfe-express', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBfeNumber(number))) };
};
