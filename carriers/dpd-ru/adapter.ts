import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { dpdRuRequestNumber } from './number.js';
import { DPD_RU_MAX_BYTES, parseDpdRu, PROVIDER } from './parser.js';

/**
 * The search behind the tracking page of DPD's network in Russia, Belarus and
 * Kazakhstan. Its Kazakh and Belarusian portals answer for the orders of all
 * three; dpd.ru's sits behind a bot wall.
 */
export const DPD_RU_SEARCH = 'https://mydpd.dpd.kz/ols/trace2/standard.do2?method:search';
export const DPD_RU_SEARCH_AGAIN = 'https://mydpd.dpd.by/ols/trace2/standard.do2?method:search';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class DpdRuTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(url: string, number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(url, { method: 'POST', signal,
      body: new URLSearchParams({ orderNum: number, orderId: '' }).toString(),
      headers: {
        Accept: 'text/html, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DPD_RU_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'DPD Russia tracking search is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'DPD Russia refused the lookup', { status: 403 });
    if (REDIRECTS.includes(response.status)) throw new SchemaError(PROVIDER, 'DPD Russia redirected its tracking search', { status: response.status });
    return parseDpdRu(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = dpdRuRequestNumber(raw);
    // A lookup that fails to reach the Kazakh portal, or hangs, asks the
    // Belarusian one once: the first try gets half of the budget.
    return runSteps({ carrier: 'dpd-ru', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(DPD_RU_SEARCH, number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(DPD_RU_SEARCH_AGAIN, number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DpdRuTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dpd-ru', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => dpdRuRequestNumber(number))),
  };
};
