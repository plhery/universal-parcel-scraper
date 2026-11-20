import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider, type ReferenceType } from './parser.js';

const portal = 'https://www.asgl.vn/en/tracking';
const endpoint = 'https://ccteam.asgl.net.vn/api/tracking';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(provider, 'Enter an ASG air waybill or delivery order number');
    const type: ReferenceType = /^\d{11}$/.test(number) ? 'mawb' : /^\d{10}$/.test(number) ? 'do' : 'hawb';
    const reference = type === 'mawb' ? `${number.slice(0, 3)}-${number.slice(3)}` : number;
    const body = JSON.stringify({ tracking_number: reference, tracking_type: type, phone: '' });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST', body, headers: {
            Accept: 'application/json', 'Content-Type': 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent),
          }, signal,
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 500_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'ASG Logistics refused the shipment search');
        return parseTracking(decodeText(bytes), number, type);
      },
    }]);
  },
});
