import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://tracking.sunriselg.com';
const endpoint = 'https://tracking-api.sunriselg.com/api/v1/seguimiento-embarques-aereo/numDoc/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase().replace(/^(BOG)-?(\d{6})$/, '$1-$2');
    if (!/^[A-Z0-9][A-Z0-9-]{3,44}[A-Z0-9]$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a Sunrise Logistics house air waybill');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const items: unknown[] = [];
        for (let page = 1; page <= 4; page += 1) {
          const url = endpoint + encodeURIComponent(number) + '?page=' + page + '&pageSize=50';
          const { bytes, response } = await fetchBounded(url, {
            signal, headers: {
              Accept: 'application/json', Origin: portal, Referer: portal + '/es', 'User-Agent': userAgentOf(environment.userAgent),
            },
          }, {
            provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 600_000, allowHttpStatuses: [403, 404],
          });
          const body = decodeText(bytes);
          if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl/i.test(body)) {
            throw new ChallengeError(provider, 'Sunrise Logistics requires verification');
          }
          let data: unknown;
          try {
            data = JSON.parse(body);
          } catch {
            throw new SchemaError(provider, 'Sunrise Logistics returned invalid tracking JSON');
          }
          if (response.status === 404 && isRecord(data) && data.title === 'SeguimientoEmbarqueAereo.NotFound') {
            if (items.length) break;
            throw new NotFoundError(provider);
          }
          if (!isRecord(data) || !Array.isArray(data.items)) {
            throw new SchemaError(provider, 'Sunrise Logistics did not return an air freight history page');
          }
          const pageItems: unknown[] = data.items;
          items.push(...pageItems);
          if (data.hasNextPage !== true) break;
        }
        return parseTracking(items, number);
      },
    }]);
  },
});
