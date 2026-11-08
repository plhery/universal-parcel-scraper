import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { JT_BR_API, JT_BR_MAX_BYTES, JT_BR_PAGE, normalizeJAndTBrNumber, parseJAndTBr, PROVIDER } from './parser.js';
function retryAfter(headers: Record<string, string>): number | undefined {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]?.trim();
  const delay = value === undefined ? NaN : /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
export class JAndTBrTracker {
  constructor(private readonly environment: AdapterEnvironment) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeJAndTBrNumber(raw);
    return runSteps({ carrier: 'j-and-t-br', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 90_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'J&T Brazil needs the browser tracking service');
      const timeoutMs = Math.floor(Math.min(90_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      if (timeoutMs < 12000) throw new BudgetExceededError(PROVIDER, remainingMs);
      const url = `${JT_BR_PAGE}?${new URLSearchParams({ waybillNo: number })}`;
      const page = await this.environment.trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [JT_BR_API], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * JT_BR_MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'J&T Brazil left its tracking page');
      const matching = page.capturedResponses.filter(row => row.url === JT_BR_API);
      if (matching.length > 2) throw new SchemaError(PROVIDER, 'J&T Brazil returned too many tracking replies');
      let result: CarrierResult | undefined, failure: Error | undefined;
      for (const row of matching) {
        if (row.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'The browser did not bind the whole J&T Brazil request');
        result = undefined;
        if (row.status <= 0) { failure = new TransportError(PROVIDER, 'The guest tracking request failed'); continue; }
        if ([401, 403, 428].includes(row.status)) { failure = new ChallengeError(PROVIDER, 'J&T Brazil refused its tracking request', { status: row.status }); continue; }
        if ([404, 410].includes(row.status)) { failure = new TransportError(PROVIDER, 'J&T Brazil guest endpoint is unavailable'); continue; }
        if (row.status !== 200) { failure = new UpstreamHttpError(PROVIDER, row.status, retryAfter(row.headers)); continue; }
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'J&T Brazil returned invalid JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > JT_BR_MAX_BYTES) throw new TransportError(PROVIDER, 'J&T Brazil returned incomplete tracking data');
        let data: unknown;
        try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'J&T Brazil returned invalid JSON'); }
        try { result = parseJAndTBr(data, number); failure = undefined; }
        catch (error) { if (error instanceof SchemaError) throw error;
          if (!(error instanceof Error)) throw new SchemaError(PROVIDER, 'J&T Brazil returned an unclassified reply');
          failure = error; }
      }
      if (result) return result;
      if (failure) throw failure;
      if ([404, 410].includes(page.statusCode)) throw new TransportError(PROVIDER, 'J&T Brazil tracking page is unavailable');
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      if (isRecord(timing) && ['jt-br-runtime', 'jt-br-capture_missing'].includes(String(timing.reason))) {
        throw new TransportError(PROVIDER, 'J&T Brazil could not complete its guest response capture');
      }
      throw new ChallengeError(PROVIDER, 'J&T Brazil returned no bound guest reply', { reason: 'verification_unfinished' });
    } }]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new JAndTBrTracker(environment);
  return { id: 'j-and-t-br', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
