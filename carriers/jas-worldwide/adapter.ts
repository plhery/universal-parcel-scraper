import { lookupBudget, type AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseDetails, parseReference, provider } from './parser.js';

const portal = 'https://myjas.com/public/shipments';
// MyJAS publishes this read action in its public shipment grid bundle.
const detailAction = '40cc26af94904e739acabbbbdc2209485934401fb8';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a MyJAS shipment number or house bill');
    }
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const budget = lookupBudget({ signal, budgetMs: remainingMs }, 15_000, provider);
        const headers = { Accept: 'text/x-component', 'User-Agent': userAgentOf(environment.userAgent) };
        const url = `${portal}?${new URLSearchParams({ shipmentNumber: number })}`;
        const request = async (address: string, init: RequestInit) => {
          const { bytes, response } = await fetchBounded(address, { ...init, signal: budget.signal }, {
            provider, timeoutMs: budget.remainingMs(), maxBytes: 512 * 1024, fetcher: environment.fetcher,
          });
          const body = decodeText(bytes);
          if (!response.headers.get('content-type')?.startsWith('text/x-component')) {
            if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(body)) {
              throw new ChallengeError(provider, 'MyJAS returned a verification page');
            }
            throw new SchemaError(provider, 'Expected a MyJAS component response');
          }
          return body;
        };
        const grid = await request(`${url}&_rsc`, { headers: { ...headers, RSC: '1' } });
        const reference = parseReference(grid, number);
        const details = await request(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://myjas.com', 'Next-Action': detailAction },
          body: JSON.stringify([reference.shipmentRef]),
        });
        return parseDetails(details, reference);
      },
    }]);
  },
});
