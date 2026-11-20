import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { deliveryReceiptNumber, parseDeliveryReceipt, PROVIDER } from './parser.js';

const ORIGIN = 'https://www.delivery-auto.com';
const UNAVAILABLE = [301, 302, 303, 307, 308, 404, 410];

export const adapter: AdapterFactory = environment => ({
  id: 'delivery-auto',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = deliveryReceiptNumber(input.number);
    return runSteps({ carrier: 'delivery-auto', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(`${ORIGIN}/uk-UA/Receipts/DetailsNew`, {
          method: 'POST', signal,
          headers: {
            Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': userAgentOf(environment.userAgent), 'X-Requested-With': 'XMLHttpRequest',
            Origin: ORIGIN, Referer: `${ORIGIN}/uk-UA/Home/SearchReceipt`,
          },
          body: new URLSearchParams({ id: number, delGruop: '1' }).toString(),
        }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 500_000,
          redirect: 'manual', fetcher: environment.fetcher, allowHttpStatuses: UNAVAILABLE });
        signal.throwIfAborted();
        if (response.status !== 200) {
          throw new TransportError(PROVIDER, 'Delivery receipt lookup is unavailable', { status: response.status });
        }
        return parseDeliveryReceipt(decodeText(bytes), number);
      },
    }]);
  },
});
