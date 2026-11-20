import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseBill, parseMovements, provider } from './parser.js';

const origin = 'https://ct.shipmentlink.com';
const trackingUrl = origin + '/servlet/TDB1_CargoTracking.do';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = /^(?:EGLV[ -]?)?(\d{12})$/i.exec(input.number.trim())?.[1];
    if (!number) throw new InvalidInputError(provider, 'Enter a twelve-digit Evergreen bill of lading number');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const headers = {
          Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded',
          Origin: origin, Referer: trackingUrl, 'User-Agent': userAgentOf(environment.userAgent),
        };
        const read = async (fields: URLSearchParams) => {
          signal.throwIfAborted();
          const timeoutMs = Math.floor(deadline - performance.now());
          if (timeoutMs < 1) throw new BudgetExceededError(provider, remainingMs);
          const { bytes, response } = await fetchBounded(trackingUrl, {
            method: 'POST', headers, body: fields, signal,
          }, {
            provider, timeoutMs, fetcher: environment.fetcher, maxBytes: 400_000, allowHttpStatuses: [403],
          });
          if (response.status === 403) throw new ChallengeError(provider, 'ShipmentLink refused the tracking request');
          return decodeText(bytes);
        };
        const bill = await read(new URLSearchParams({
          BL: number, CNTR: '', bkno: '', TYPE: 'BL', SEL: 's_bl', NO: number,
        }));
        const movement = parseBill(bill, number);
        return parseMovements(await read(movement.fields), movement.container);
      },
    }]);
  },
});
