import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isWangjingNumber, normalizeWangjingNumber, parseWangjing, PROVIDER, WANGJING_MAX_BYTES } from './parser.js';

/** The lookup 3CQ's tracking page on track.wjdrop.com makes for the numbers in `nums`. */
export const WANGJING_API = 'https://track.wjdrop.com/api/tracking/list';
// A missing or refused route is a moved lookup, never a missing parcel.
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 15_000;

export const adapter: AdapterFactory = (environment) => {
  async function read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page asks with its own language, Chinese unless the visitor picks another; the scans read the same.
    const { response, bytes } = await fetchBounded(WANGJING_API, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', lang: 'zh-CN',
      Origin: 'https://track.wjdrop.com', Referer: `https://track.wjdrop.com/tracking/index?nums=${encodeURIComponent(number)}`,
      'User-Agent': userAgentOf(environment.userAgent),
    }, body: JSON.stringify({ trackingNumbers: [number] }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      maxBytes: WANGJING_MAX_BYTES, fetcher: environment.fetcher, allowHttpStatuses: GONE });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Wangjing 3CQ tracking lookup is unavailable', { status: response.status });
    return parseWangjing(decodeText(bytes), number, response.status);
  }

  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    async track(input, context = {}) {
      const number = normalizeWangjingNumber(input.number);
      if (!isWangjingNumber(number)) throw new InvalidInputError(PROVIDER, 'Invalid Wangjing 3CQ tracking number');
      // A read that fails to reach 3CQ, or hangs, is sent once more: the first try gets half of the budget.
      return runSteps({ carrier: PROVIDER, recorder: environment.recorder, signal: context.signal,
        budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS }, [
        { id: 'direct', run: ({ signal, remainingMs }) => read(number, signal, firstAttemptMs(remainingMs)) },
        networkRetryStep(({ signal, remainingMs }) => read(number, signal, remainingMs)),
      ]);
    },
  };
};
