import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, MaintenanceError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { paused } from '../../core/runner/pause.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeDhlEcommerceEsNumber, parseDhlEcommerceEs } from './parser.js';

const PROVIDER = 'DHL eCommerce Iberia';
// The gateway behind clientesparcel.dhl.es. A number without a postcode returns
// the public history; a wrong postcode would strip the shipment header.
const ENDPOINT = 'https://clientesparcel.dhl.es/LiveTracking.GTW/api/shipment-detail';
// The notice the tracking page shows above every search. It carries no number.
const BANNER = 'https://clientesparcel.dhl.es/LiveTracking.GTW/api/banner';
const BANNER_MIN_MS = 1_000;
const BANNER_MAX_MS = 5_000;
const GATEWAY_FAILURES = new Set([500, 502, 503, 504]);
// The gateway's balancer sends some requests to a member that answers a shipment it holds with
// the empty 204 at once, and the next request, sent the same way, gets the shipment; another few
// get a bare 500, for known and unknown numbers alike. Those answers are asked again, after a
// pause, while the budget allows: a missing parcel is an empty 204 with nothing but 204s and
// 500s around it, and 500s alone stay a failure.
const EMPTY_TRIES = 4;
const EMPTY_PAUSE_MS = 150;
const EMPTY_RETRY_MIN_MS = 2_000;

export class DhlEcommerceEsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDhlEcommerceEsNumber(raw);
    return runSteps({ carrier: 'dhl-ecommerce-es', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      if (remainingMs <= 0) throw new BudgetExceededError(PROVIDER, context.budgetMs ?? 15_000);
      const deadline = performance.now() + remainingMs;
      const url = new URL(ENDPOINT);
      url.searchParams.set('number', number);
      const ask = () => fetchBounded(url, { signal, headers: { Accept: 'application/json', 'Accept-Language': 'en-US',
        cultura: 'en', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: 2_000_000,
        allowHttpStatuses: [409, 503], fetcher: this.options.fetcher,
      });
      const empty = (reply: { response: Response; bytes: Uint8Array }) => reply.response.status === 204 && !reply.bytes.byteLength;
      let reply: Awaited<ReturnType<typeof ask>> | undefined;
      let failure: unknown;
      let emptied = false;
      for (let tries = 0; tries < EMPTY_TRIES; tries++) {
        if (tries) {
          if (deadline - performance.now() < EMPTY_RETRY_MIN_MS) break;
          if (!await paused(EMPTY_PAUSE_MS, signal)) signal.throwIfAborted();
        }
        try {
          reply = await ask();
        } catch (cause) {
          if (!(cause instanceof UpstreamHttpError && cause.status === 500)) throw cause;
          [reply, failure] = [undefined, cause];
          continue;
        }
        if (!empty(reply)) break;
        emptied = true;
      }
      // An unknown or purged number is an empty 204, every time it is asked. A 409 asks
      // for the postcode of a number two shipments share. During maintenance the gateway
      // gives every number the empty 204 while its other endpoints fail, the banner among them.
      if (!reply || empty(reply)) {
        if (!emptied) throw failure;
        if (await this.#down(signal, deadline)) throw new MaintenanceError(PROVIDER, "DHL eCommerce Iberia's tracker is down for maintenance");
        throw new NotFoundError(PROVIDER);
      }
      const { response, bytes } = reply;
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Iberia returned an inconclusive tracking response');
      // The firewall rejects a request with an HTML page under HTTP 200.
      if (!/json/i.test(response.headers.get('content-type') ?? '')) {
        if (/Request Rejected/i.test(decodeText(bytes.subarray(0, 2_000)))) throw new ChallengeError(PROVIDER, 'DHL eCommerce Iberia rejected the tracking request');
        throw new IndeterminateError(PROVIDER, 'DHL eCommerce Iberia returned an inconclusive tracking response');
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'DHL eCommerce Iberia returned invalid tracking JSON', { cause }); }
      return parseDhlEcommerceEs(payload, number);
    } }]);
  }

  /** Whether the banner fails as the gateway does under maintenance; without the time to ask, the 204 stands. */
  async #down(signal: AbortSignal, deadline: number): Promise<boolean> {
    const timeoutMs = Math.min(BANNER_MAX_MS, Math.floor(deadline - performance.now()));
    if (timeoutMs < BANNER_MIN_MS) return false;
    try {
      const { response } = await fetchBounded(BANNER, { signal, headers: { Accept: 'application/json', 'Accept-Language': 'en-US',
        cultura: 'en', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs, maxBytes: 20_000, allowHttpStatuses: [...GATEWAY_FAILURES], fetcher: this.options.fetcher,
      });
      return GATEWAY_FAILURES.has(response.status);
    } catch {
      // A banner that cannot be read says nothing about the gateway.
      signal.throwIfAborted();
      return false;
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DhlEcommerceEsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dhl-ecommerce-es', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDhlEcommerceEsNumber(number))) };
};
