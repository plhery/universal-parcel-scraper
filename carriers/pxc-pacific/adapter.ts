import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePxcNumber, parsePxc, PROVIDER, PXC_MAX_BYTES } from './parser.js';

/** The lookup PXC's tracking page on pacificexp.net makes for each number in `awbno`. */
export const PXC_API = 'https://eship.pacificexp.net/api/v1/Tracking/Tracking';
// The login the tracking page sends for every visitor, written in the page itself.
const VISITOR = { UserID: 'test1', Password: 'Test@2024#' }; // gitleaks:allow
// A missing or refused route is a moved lookup, never a missing parcel.
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 15_000;

export const adapter: AdapterFactory = (environment) => {
  async function read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // `Type` A asks by air waybill, as the page does unless the visitor picks a reference.
    const { response, bytes } = await fetchBounded(PXC_API, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json',
      Origin: 'https://www.pacificexp.net', Referer: `https://www.pacificexp.net/tracking-details.html?awbno=${encodeURIComponent(number)}`,
      'User-Agent': userAgentOf(environment.userAgent),
    }, body: JSON.stringify({ ...VISITOR, AWBNo: number, Type: 'A', RequiredUrl: 'yes' }) }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PXC_MAX_BYTES, fetcher: environment.fetcher,
      allowHttpStatuses: GONE });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'PXC Pacific Global tracking lookup is unavailable', { status: response.status });
    return parsePxc(decodeText(bytes), number, response.status);
  }

  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    async track(input, context = {}) {
      const number = normalizePxcNumber(input.number);
      // A read that fails to reach PXC, or hangs, is sent once more: the first try gets half of the budget.
      return runSteps({ carrier: PROVIDER, recorder: environment.recorder, signal: context.signal,
        budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS }, [
        { id: 'direct', run: ({ signal, remainingMs }) => read(number, signal, firstAttemptMs(remainingMs)) },
        networkRetryStep(({ signal, remainingMs }) => read(number, signal, remainingMs)),
      ]);
    },
  };
};
