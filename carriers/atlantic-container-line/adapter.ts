import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseMovements, parseShipment, provider } from './parser.js';

const tracking = 'https://my.aclcargo.com/myacl/ShipmentTracking/';
const dashboard = tracking + 'SearchDashboard?RenderType=Minimal';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = /^(?:ACLU[ -]?)?SA-?(\d{8})$/i.exec(input.number.trim())?.[1];
    if (!reference) throw new InvalidInputError(provider, 'Enter an Atlantic Container Line SA shipment number');
    const shipment = `SA-${reference}`;
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const read = async (page: string, query: Record<string, string>) => {
          signal.throwIfAborted();
          const timeoutMs = Math.floor(deadline - performance.now());
          if (timeoutMs < 1) throw new BudgetExceededError(provider, remainingMs);
          const url = new URL(page, tracking);
          url.search = new URLSearchParams(query).toString();
          const { bytes, response } = await fetchBounded(url.href, {
            headers: {
              Accept: 'text/html', Referer: dashboard, 'X-Requested-With': 'XMLHttpRequest',
              'User-Agent': userAgentOf(environment.userAgent),
            },
            signal,
          }, { provider, timeoutMs, fetcher: environment.fetcher, maxBytes: 500_000, allowHttpStatuses: [403] });
          if (response.status === 403) throw new ChallengeError(provider, 'ACL refused the cargo tracking request');
          return decodeText(bytes);
        };
        const container = parseShipment(await read('SearchGrid', { ShipmentNumber: shipment }), shipment);
        const detail = await read('Latest', { shipmentNumber: shipment, containerId: container, displaytype: '' });
        return parseMovements(detail, shipment, container);
      },
    }]);
  },
});
