import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  normalizePlaneteCourrierNumber, parsePlaneteCourrierDetail, parsePlaneteCourrierList, PLANETE_COURRIER_MAX_BYTES, PROVIDER,
} from './parser.js';

export { normalizePlaneteCourrierNumber, parsePlaneteCourrierDetail, parsePlaneteCourrierList } from './parser.js';

/** The tracker page: `?r=` lists the orders a number names, and `&detail=true` shows one order's page. */
export const PLANETE_COURRIER_TRACKER = 'https://www.planetecourrier.com/fr/suivi-courrier.html';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

export const planeteCourrierListUrl = (number: string): string => `${PLANETE_COURRIER_TRACKER}?r=${encodeURIComponent(number)}`;
export const planeteCourrierDetailUrl = (number: string): string => `${planeteCourrierListUrl(number)}&detail=true`;

export class PlaneteCourrierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs, maxBytes: PLANETE_COURRIER_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
    // A redirect is a moved tracker, not a missing order.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Planète Courrier tracking moved', { status: response.status });
    return decodeText(bytes);
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    // The order's page holds its history, even for an order the list calls expired. It answers a number
    // it holds no order under with an undated page, so only the list's notice says the order is missing.
    const detail = parsePlaneteCourrierDetail(await this.get(planeteCourrierDetailUrl(number), signal, timeoutMs), number);
    if (detail) return detail;
    return parsePlaneteCourrierList(await this.get(planeteCourrierListUrl(number), signal, Math.max(1, deadline - Date.now())), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePlaneteCourrierNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PlaneteCourrierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
