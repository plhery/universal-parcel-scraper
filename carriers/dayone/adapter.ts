import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { RTB56_REDIRECTS, rtb56Json, rtb56LookupUrl } from '../yypost/rtb56.js';
import { DAYONE_MAX_BYTES, normalizeDayoneNumber, parseDayone, PROVIDER } from './parser.js';

/** The tracker's page for one parcel. */
export const DAYONE_PAGE = 'https://www.dayonetrack.com/track';
/** The lookup the page makes for a number with DOT0. */
export const DAYONE_API = 'https://www.dayonetrack.com/api/webservice/Service.ashx';
/** The JSONP callback the adapter names, as the page's jQuery does. */
export const DAYONE_CALLBACK = 'dayoneTrack';
/** The lookup the page makes for a number with DOT1, on DayOne's ERP. */
export const DAYONE_ERP = 'https://erp.dayoneerp.com/dayone-api/queryTrackingInfo';

/** The page's request for one number. */
export function dayoneLookupUrl(number: string): string {
  return rtb56LookupUrl(DAYONE_API, DAYONE_CALLBACK, number);
}

/** The ERP's request for one number with DOT1, as the page sends it. */
export function dayoneErpUrl(number: string): string {
  return `${DAYONE_ERP}?id=${encodeURIComponent(number)}`;
}

export class DayoneTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDayoneNumber(raw);
    // The page sends DOT1 to DayOne's ERP and no other number anywhere.
    const erp = number.startsWith('DOT1');
    if (!erp && !number.startsWith('DOT0')) throw new IndeterminateError(PROVIDER, 'DayOne’s tracker has no lookup for this number');
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(erp ? dayoneErpUrl(number) : dayoneLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: erp ? 'application/json, text/plain, */*' : 'text/javascript, application/javascript, */*; q=0.01',
        Referer: `${DAYONE_PAGE}?trackNo=${number}`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DAYONE_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410] });
      // Both lookups answer every number with HTTP 200; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'DayOne tracking lookup moved', { status: response.status });
      const body = decodeText(bytes);
      // The ERP answers an empty body for a number it holds nothing under, and has for numbers it later answered.
      if (erp && !body.trim()) throw new IndeterminateError(PROVIDER, 'DayOne’s ERP answered nothing for this number');
      return parseDayone(rtb56Json(body, DAYONE_CALLBACK, PROVIDER), number, { erp });
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'dayone', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DayoneTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dayone', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
