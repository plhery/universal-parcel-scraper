import { accepted, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { StepRecord, StepRecorder } from '../../core/telemetry/index.js';
import { browserContextProxy } from '../../core/transport/browserRouteTrial.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { API, COURIER_API, MAX_BYTES, normalizeWanbLookup, normalizeWanbNumber, ORIGIN, parseWanb, PROVIDER, wanbShippingService, withWanbCourier } from './parser.js';
import { fetchWanbInBrowser } from './browser.js';

type Route = NonNullable<StepRecord['networkRoute']>;

/** One lookup's browser-service reads: the latest one's route, how many, and whether it returned dated history. */
interface ReadRoute { route: Route | null; reads: number; history: boolean }

interface StepArgs { signal: AbortSignal; remainingMs: number }

export class WanbTracker {
  private readonly fallbackProxy: string | null;

  constructor(private readonly environment: AdapterEnvironment) {
    const proxy = environment.env.WANBEXPRESS_FALLBACK_PROXY_URL?.trim() || null;
    // Checked here, so a mistyped proxy fails at setup with a message that leaves its value out.
    if (proxy) browserContextProxy(proxy);
    this.fallbackProxy = proxy;
  }

  private get endpoint(): string | null { return this.environment.env.WANBEXPRESS_BROWSER_WS_ENDPOINT?.trim() || null; }

  /**
   * The browser steps. With a fallback proxy, a read the tracker refuses on the browser
   * service's own address is made once more through the proxy, and the first read leaves
   * it half of the time; recognition never uses it.
   */
  browserSteps(number: string, read: ReadRoute = { route: null, reads: 0, history: false }, fallback = false) {
    const proxy = fallback && this.environment.trawl ? this.fallbackProxy : null;
    return [
      { id: 'browser', enabled: !!this.endpoint, run: async ({ signal, remainingMs }: StepArgs) => {
        const deadline = performance.now() + remainingMs;
        const payload = await fetchWanbInBrowser(number, this.endpoint!, signal, Math.max(1, Math.min(20_000, remainingMs - 2000)));
        return this.read(payload, number, signal, deadline);
      } },
      { id: 'trawl', enabled: !!this.environment.trawl,
        run: ({ signal, remainingMs }: StepArgs) => this.browser(number, signal, proxy ? remainingMs / 2 : remainingMs, null, read) },
      { id: 'trawl', enabled: !!proxy, recovers: (error: unknown) => error instanceof ChallengeError && read.route === 'default',
        run: ({ signal, remainingMs }: StepArgs) => this.browser(number, signal, remainingMs, proxy, read) },
    ];
  }

  /** The recorder, with each browser-service read's route, attempt and dated history on its step. */
  private routed(read: ReadRoute): StepRecorder {
    const recorder = this.environment.recorder;
    return {
      step: record => recorder.step(read.route && record.step === 'trawl' ? { ...record, networkRoute: read.route,
        networkAttempt: read.reads > 1 ? 'retry' : 'initial', historyAvailable: read.history } : record),
      lookup: record => recorder.lookup(record),
    };
  }

  async direct(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWanbLookup(raw);
    const deadline = performance.now() + (context.budgetMs ?? 5000);
    // Node's fetch sends `Accept-Language: *` unless told otherwise, and the
    // tracker fails on it with HTTP 500, often after several seconds.
    const { bytes } = await fetchBounded(`${API}?TrackingNumber=${number}`, { signal: context.signal,
      headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.environment.userAgent) } },
    { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(context.budgetMs ?? 5000)), maxBytes: MAX_BYTES, fetcher: this.environment.fetcher });
    return this.read(this.decode(decodeText(bytes)), number, context.signal, deadline);
  }

  private decode(body: string): unknown {
    if (/^\s*</.test(body)) throw new ChallengeError(PROVIDER, 'WanbExpress returned a browser challenge');
    try { return JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'WanbExpress returned invalid JSON'); }
  }

  /**
   * Parses the tracking reply, then asks the last-mile panel for the courier of its shipping
   * service within the lookup's deadline. The panel needs no verification; without its answer
   * the courier's number stays unattributed.
   */
  private async read(payload: unknown, number: string, signal: AbortSignal | undefined, deadline: number): Promise<CarrierResult> {
    const result = parseWanb(payload, number);
    const service = wanbShippingService(payload);
    const timeoutMs = Math.min(3000, Math.floor(deadline - performance.now() - 500));
    if (!result.delivery_tracking_number || !service || timeoutMs < 500) return result;
    try {
      const { bytes } = await fetchBounded(`${COURIER_API}?shippingServiceId=${encodeURIComponent(service)}&trackingNumber=${result.delivery_tracking_number}`, { signal,
        headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.environment.userAgent) } },
      { provider: PROVIDER, timeoutMs, maxBytes: 20_000, fetcher: this.environment.fetcher });
      return withWanbCourier(result, JSON.parse(decodeText(bytes)));
    } catch {
      signal?.throwIfAborted();
      return result;
    }
  }

  async browser(raw: string, signal: AbortSignal, remainingMs: number, proxy: string | null = null,
    read: ReadRoute = { route: null, reads: 0, history: false }): Promise<CarrierResult> {
    const number = normalizeWanbLookup(raw);
    const deadline = performance.now() + remainingMs;
    if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'WanbExpress requires the browser tracking service');
    const timeoutMs = Math.floor(remainingMs - 2000);
    if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
    read.route = proxy ? 'residential' : 'default';
    read.reads += 1;
    read.history = false;
    // Through the proxy the service carries the whole context there, never its own address, and
    // its helper runs the page's passive check alone: a visible checkbox ends the read.
    const page = await this.environment.trawl.scrape({ url: `${ORIGIN}/?trackingNumbers=${number}`, skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs, captureResponses: [API], settleTimeout: timeoutMs, ...(proxy ? { proxy } : {}) },
    { provider: PROVIDER, timeoutMs, signal, maxBytes: 6 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
    signal.throwIfAborted();
    const matching = page.capturedResponses.filter(row => {
      try { const url = new URL(row.url); return url.origin + url.pathname === API && !url.username && !url.password
        && url.searchParams.getAll('TrackingNumber').length === 1 && url.searchParams.get('TrackingNumber') === number; } catch { return false; }
    });
    const response = matching.at(-1);
    if (!response || matching.length > 10) throw new ChallengeError(PROVIDER, 'WanbExpress returned no matching tracking response');
    if (response.status === 429) throw new RateLimitedError(PROVIDER);
    if ([401, 403, 428].includes(response.status)) throw new ChallengeError(PROVIDER);
    if (response.status >= 400) throw new UpstreamHttpError(PROVIDER, response.status);
    if (response.error || response.truncated || response.base64Encoded || response.body === null) throw new TransportError(PROVIDER, 'WanbExpress returned an incomplete browser response');
    if (response.status !== 200 || Buffer.byteLength(response.body) > MAX_BYTES) throw new SchemaError(PROVIDER, 'WanbExpress returned invalid browser data');
    const result = await this.read(this.decode(response.body), number, signal, deadline);
    read.history = Boolean(result.events?.some(event => event.time || event.local_time));
    return result;
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWanbLookup(raw);
    // The tracker refuses plain lookups with its verification code, so with a browser to
    // ask the lookup starts there; HTTP recognition still makes the plain request.
    const read: ReadRoute = { route: null, reads: 0, history: false };
    const browsers = this.browserSteps(number, read, true);
    const browser = browsers.some(step => step.enabled);
    return runSteps({ carrier: 'wanbexpress', budgetMs: context.budgetMs ?? 45000, signal: context.signal, recorder: this.routed(read) }, [
      { id: 'direct', enabled: !browser, run: ({ signal, remainingMs }) => this.direct(number, { signal, budgetMs: Math.min(5000, remainingMs) }) },
      ...browsers,
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new WanbTracker(environment);
  return { id: 'wanbexpress', recordsSteps: true, steps: ['direct', ...(environment.env.WANBEXPRESS_BROWSER_WS_ENDPOINT?.trim() ? ['browser'] : []), 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.direct(number, context), () => accepted(() => normalizeWanbNumber(number))),
    recognizeWithBrowser: (number, context, previous) => {
      if (previous instanceof SchemaError || previous instanceof RateLimitedError) return Promise.reject(previous);
      if (!environment.env.WANBEXPRESS_BROWSER_WS_ENDPOINT?.trim() && !environment.trawl) return Promise.reject(new ChallengeError(PROVIDER, 'WanbExpress requires a browser tracking service'));
      return recognizeFromBrowserLookup(() => runSteps({ carrier: 'wanbexpress', budgetMs: context?.budgetMs ?? 45000,
        signal: context?.signal, recorder: environment.recorder }, [
        ...tracker.browserSteps(normalizeWanbNumber(number)),
      ]));
    } };
};
