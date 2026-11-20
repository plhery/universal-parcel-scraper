import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isXindusNumber, normalizeXindusNumber, parseXindus, PROVIDER, XINDUS_MAX_BYTES } from './parser.js';

/** The lookup Xindus's tracking page on xindus.net makes for the number typed in or given as `awb`. */
export const XINDUS_API = 'https://os.xindus.net/ixos-service/oapi/shipment-tracking/shipment';
// An unknown number is a 500 with its own description; a 404 or 410 is a moved route.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export const adapter: AdapterFactory = (environment) => {
  async function read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${XINDUS_API}?scancode=${encodeURIComponent(number)}`;
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Origin: 'https://www.xindus.net', Referer: 'https://www.xindus.net/',
      'User-Agent': userAgentOf(environment.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: XINDUS_MAX_BYTES,
      fetcher: environment.fetcher, allowHttpStatuses: [...GONE, 500] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Xindus tracking lookup is unavailable', { status: response.status });
    return parseXindus(decodeText(bytes), number, response.status);
  }

  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    async track(input, context = {}) {
      const number = normalizeXindusNumber(input.number);
      if (!isXindusNumber(number)) throw new InvalidInputError(PROVIDER, 'Invalid Xindus tracking number');
      // A read that fails to reach Xindus, or hangs, is sent once more: the first try gets half of the budget.
      return runSteps({ carrier: PROVIDER, recorder: environment.recorder, signal: context.signal,
        budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS }, [
        { id: 'direct', run: ({ signal, remainingMs }) => read(number, signal, firstAttemptMs(remainingMs)) },
        networkRetryStep(({ signal, remainingMs }) => read(number, signal, remainingMs)),
      ]);
    },
  };
};
