import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { CARRIER, KEC_MAX_BYTES, normalizeKecNumber, parseKec, PROVIDER } from './parser.js';

export const KEC_API = 'https://tt.kec-app.com/api/status';
// The official https://kec.kln.com/en/logistics-tracking/ guest widget gives every visitor this value.
const GUEST_AUTHORIZATION = "3JyyUBfZZY3yQydd"; // gitleaks:allow
const CHALLENGE = /_cf_chl_opt|cf-chl-|cf-turnstile|AwsWafIntegration|<title>\s*(?:Just a moment|Attention Required|Access Denied)|verify you are human|captcha/i;

export class KecTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeKecNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number) => {
      const url = `${KEC_API}?${new URLSearchParams({ tracking_number: number })}`;
      let reply: Awaited<ReturnType<typeof fetchBounded>>;
      try {
        reply = await fetchBounded(url, { method: 'GET', signal, headers: {
          authorization: GUEST_AUTHORIZATION, Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
          Origin: 'https://kec.kln.com', Referer: 'https://kec.kln.com/en/logistics-tracking/',
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: KEC_MAX_BYTES,
          redirect: 'manual', allowHttpError: true, fetcher: this.options.fetcher });
      } catch (error) {
        signal.throwIfAborted();
        // Transport diagnostics contain the number and authorization header;
        // preserve the failure kind and retry eligibility without retaining them.
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, undefined);
        if (error instanceof CarrierError) throw new CarrierError(error.kind, PROVIDER, 'KEC eCommerce could not read its tracking feed', {
          status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason });
        throw new TransportError(PROVIDER);
      }
      signal.throwIfAborted();
      const { response, bytes } = reply, body = decodeText(bytes);
      if (response.url && response.url !== url) throw new TransportError(PROVIDER, 'KEC eCommerce redirected its tracking feed');
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'KEC eCommerce refused the guest lookup', { status: response.status });
      if (response.status === 429) throw new UpstreamHttpError(PROVIDER, 429, retryAfter(response));
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'KEC eCommerce answered with browser verification');
      if ([301, 302, 303, 307, 308, 404, 405, 410].includes(response.status)) throw new TransportError(PROVIDER, 'KEC eCommerce tracking endpoint is unavailable', { status: response.status });
      // Unknown numbers also produce HTTP 500; no HTTP error establishes not-found.
      if (!response.ok) throw new UpstreamHttpError(PROVIDER, response.status, retryAfter(response));
      let payload: unknown;
      try { payload = JSON.parse(body); }
      catch { throw new SchemaError(PROVIDER, 'KEC eCommerce returned a reply that is not JSON'); }
      return parseKec(payload, number);
    };
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  const milliseconds = value === null ? NaN : /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

export const adapter: AdapterFactory = environment => {
  const tracker = new KecTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
