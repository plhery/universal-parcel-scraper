import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseBill, parseMovements, provider } from './parser.js';

const origin = 'https://esvc.smlines.com';
const trackingUrl = origin + '/smline/CUP_HOM_3301.do?sessLocale=en';
const endpoint = origin + '/smline/CUP_HOM_3301GS.do';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = /^(?:SMLM[ -]?)?([A-Z0-9]{12})$/i.exec(input.number.trim())?.[1]?.toUpperCase();
    if (!number) throw new InvalidInputError(provider, 'Enter a twelve-character SM Line bill of lading number');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const headers = {
          Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest', Origin: origin, Referer: trackingUrl,
          'User-Agent': userAgentOf(environment.userAgent),
        };
        const read = async (fields: Record<string, string>) => {
          signal.throwIfAborted();
          const timeoutMs = Math.floor(deadline - performance.now());
          if (timeoutMs < 1) throw new BudgetExceededError(provider, remainingMs);
          const { bytes, response } = await fetchBounded(endpoint, {
            method: 'POST', headers, body: new URLSearchParams(fields), signal,
          }, {
            provider, timeoutMs, fetcher: environment.fetcher, maxBytes: 600_000, allowHttpStatuses: [403],
          });
          if (response.status === 403) throw new ChallengeError(provider, 'SM Line refused the tracking request');
          return decodeText(bytes);
        };
        const bill = await read({ f_cmd: '121', search_type: 'B', search_name: number, cust_cd: '', page: '1', rows: '15' });
        const { container, booking, movementId } = parseBill(bill, number);
        const movements = await read({ f_cmd: '125', cntr_no: container, bkg_no: booking, cop_no: movementId });
        return parseMovements(movements, movementId);
      },
    }]);
  },
});
