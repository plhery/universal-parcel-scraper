import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  BRUDAM_LOOKUP, brudamRecord, isRodonavesBlocked, normalizeRodonavesNumber, parseBrudam, parseRodo, PROVIDER, RODO_LOOKUP,
  RODONAVES_MAX_BYTES, rodonavesJson, TRACKER_PAGE,
} from './parser.js';

export { BRUDAM_LOOKUP, normalizeRodonavesNumber, parseBrudam, parseRodo, RODO_LOOKUP } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/json\b/i;
const DEFAULT_BUDGET_MS = 30_000;

type Read = { kind: 'reply'; payload: unknown } | { kind: 'empty' };

export class RodonavesTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One of the two lookups the tracking page makes. No session; the page's reCAPTCHA token is not checked. */
  private async get(url: string, signal: AbortSignal, timeoutMs: number): Promise<Read> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Referer: TRACKER_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: RODONAVES_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 204, 401, 403, 404],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403) {
      throw new ChallengeError(PROVIDER, isRodonavesBlocked(body) ? 'Rodonaves answered with a browser check' : 'Rodonaves refused the lookup', { status });
    }
    // The road system answers a number it does not hold with no content.
    if (status === 204 || (status === 200 && body.trim() === '')) return { kind: 'empty' };
    if (status !== 200) throw new TransportError(PROVIDER, 'Rodonaves tracking is unavailable', { status });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '') && isRodonavesBlocked(body)) {
      throw new ChallengeError(PROVIDER, 'Rodonaves answered with a browser check', { status });
    }
    return { kind: 'reply', payload: rodonavesJson(body) };
  }

  /**
   * The page's order: the road system first, then Brudam, which holds the Rodo Aéreo services'
   * minutas. Only both systems' own answers that they hold nothing make the number not found.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let roadFailure: Error | null = null;
    let roadListed = false;
    try {
      // The road system gets at most two thirds of the time, so Brudam is always asked.
      const road = await this.get(`${RODO_LOOKUP}?ProtocolNumber=${number}`, signal, Math.floor(timeoutMs * 2 / 3));
      if (road.kind === 'reply') {
        const payload = road.payload;
        if (isRecord(payload) && Array.isArray(payload.Events) && payload.Events.length > 0) return parseRodo(payload, number);
        // The page asks Brudam after a reply without events or its servlet's refusal too.
        if (isRecord(payload) && payload.ProtocolNumber !== undefined && payload.ProtocolNumber !== null) roadListed = true;
        else if (!(isRecord(payload) && payload.success === false)) throw new SchemaError(PROVIDER, 'Rodonaves returned an unexpected road reply');
        else roadFailure = new IndeterminateError(PROVIDER, 'Rodonaves did not complete the road lookup');
      }
    } catch (error) {
      if (error instanceof ChallengeError || signal.aborted || !(error instanceof Error)) throw error;
      roadFailure = error;
    }
    const air = await this.get(`${BRUDAM_LOOKUP}?codigo=${number}&prefixo=minuta`, signal, left());
    if (air.kind === 'empty') {
      if (roadFailure) throw roadFailure;
      throw new IndeterminateError(PROVIDER, 'Rodonaves answered the Rodo Aéreo lookup with no content');
    }
    if (brudamRecord(air.payload, number) === 'not_found') {
      if (roadFailure) throw roadFailure;
      if (roadListed) throw new NoHistoryError(PROVIDER, 'Rodonaves lists the shipment without events', { reason: 'listed' });
      throw new NotFoundError(PROVIDER, 'Rodonaves has no shipment under this number');
    }
    return parseBrudam(air.payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRodonavesNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Rodonaves for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new RodonavesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
