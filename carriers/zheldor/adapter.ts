import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { isRecord } from '../../core/types.js';
import { normalizeZheldorNumber, parseZheldorResponse, PROVIDER, ZHELDOR_MAX_BYTES } from './parser.js';

const ORIGIN = 'https://i.jde.ru';
const CONTENT_MODEL = 'xwm01ppVs'; // gitleaks:allow -- Shared routing header in the public tracking script.

function anonymousSession(text: string, pragma: string | null): { guest: string; session: string } {
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new SchemaError(PROVIDER, 'JDE returned unreadable guest-session JSON'); }
  const guest: unknown = isRecord(body) && Array.isArray(body.result) && body.result.length === 1 ? body.result[0] : undefined;
  const fields = new Map<string, string>();
  for (const field of (pragma ?? '').split(',')) {
    const pair = /^\s*([a-z]+)=(.*?)\s*$/.exec(field);
    if (!pair || fields.has(pair[1]!)) throw new SchemaError(PROVIDER, 'JDE changed its guest session');
    fields.set(pair[1]!, pair[2]!);
  }
  const session = fields.get('dssession');
  if (typeof guest !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(guest) || !/^[A-Za-z0-9_-]{1,200}$/.test(session ?? '')
    || (fields.has('jdesid') && fields.get('jdesid') !== guest)) throw new SchemaError(PROVIDER, 'JDE changed its guest session');
  return { guest, session: session! };
}

export class ZheldorTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeZheldorNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const remaining = () => {
        signal.throwIfAborted();
        const left = Math.floor(deadline - performance.now());
        if (left < 1) throw new BudgetExceededError(PROVIDER, timeoutMs);
        return left;
      };
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent), 'Content-Type': 'text/html; charset=utf-8' };
      try {
        const sessionReply = await fetchBounded(ORIGIN + '/rqst/GetSessionId/', { signal, headers: { ...headers, Pragma: '' } },
          { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remaining(), maxBytes: 20_000 });
        remaining();
        const { guest, session } = anonymousSession(decodeText(sessionReply.bytes), sessionReply.response.headers.get('pragma'));
        const key = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
        const reply = await fetchBounded(ORIGIN + '/vM/GetDataTrack', { method: 'POST', signal, headers: {
          ...headers, 'Content-Model': CONTENT_MODEL, Pragma: `dssession=${session},jdesid=${guest}`,
          Cookie: `jdesid=${guest}; dssessiona=${session}`, 'X-Requested-With': 'XMLHttpRequest',
          Referer: ORIGIN + '/track/?' + new URLSearchParams({ ttn: number, qr: '1' }).toString(),
        }, body: JSON.stringify({ ttn: number, pincode: 1, tmpkey: key, captcha_code: '', qr: true }) },
        // The public QR page sends this same PIN placeholder; no receipt PIN is supplied.
        { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remaining(), maxBytes: ZHELDOR_MAX_BYTES, allowHttpStatuses: [500] });
        remaining();
        return parseZheldorResponse(decodeText(reply.bytes), reply.response.status, number);
      } catch (error) {
        // Guest-session headers and the verification key must stay out of diagnostics.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    };
    return runSteps({ carrier: 'zheldor', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ZheldorTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'zheldor', steps: ['direct', 'retry'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
