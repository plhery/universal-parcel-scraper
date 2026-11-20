import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { guestContext, parseCount, parseMovements, provider, trackingResult } from './parser.js';

const origin = 'https://csight.crowley.com';
const page = '/crowley/s/shipment-tracking';
const endpoint = '/crowley/s/sfsites/aura';
const pageSize = 10;
const maxPages = 10;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const bill = input.number.toUpperCase().replace(/[\s-]+/g, '').replace(/^(?:CLAM|CWLQ)(?=CW)/, '');
    if (!/^[A-Z0-9]{6,24}$/.test(bill)) {
      throw new InvalidInputError(provider, 'Enter a Crowley bill of lading from the full container tracking form');
    }

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const options = {
          provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 600_000, allowHttpStatuses: [403],
        };
        const userAgent = userAgentOf(environment.userAgent);
        const landing = await fetchBounded(origin + page, {
          headers: { Accept: 'text/html', 'User-Agent': userAgent }, signal,
        }, options);
        if (landing.response.status === 403) throw new ChallengeError(provider, 'Crowley refused its public tracking page');
        const auraContext = guestContext(decodeText(landing.bytes));
        const parameter = {
          isNonLoginPortal: true, isNonLoginPortalMultipleTracking: false, isLoginPortal: false,
          isEmployeePortalWithMultipleTracking: false, bolNumber: bill, containerId: null, portalname: 'Customer', dockReceipt: '',
        };

        async function query(method: string, queryParameter = parameter): Promise<string> {
          const actions = [{
            id: '1;a', descriptor: 'aura://ApexActionController/ACTION$execute', callingDescriptor: 'UNKNOWN',
            params: {
              namespace: '', classname: 'CC_TrackAndTraceCltr', method, params: { parameter: queryParameter },
              cacheable: false, isContinuation: false,
            },
          }];
          const result = await fetchBounded(origin + endpoint, {
            method: 'POST', signal,
            headers: {
              Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'User-Agent': userAgent, Origin: origin, Referer: origin + page,
            },
            body: new URLSearchParams({
              message: JSON.stringify({ actions }), 'aura.context': auraContext, 'aura.pageURI': page, 'aura.token': 'null',
            }),
          }, options);
          if (result.response.status === 403) throw new ChallengeError(provider, 'Crowley refused the guest bill of lading search');
          return decodeText(result.bytes);
        }

        const count = parseCount(await query('totalProcessedEquipmentEventByContainerId'));
        if (!count) throw new NotFoundError(provider);
        if (count > pageSize * maxPages) {
          throw new IndeterminateError(provider, 'Crowley returned more movements than can be retrieved within the tracking limit', { reason: 'listed' });
        }

        const events: ReturnType<typeof parseMovements> = [];
        for (let offset = 0; offset < count; offset += pageSize) {
          const queryParameter = {
            ...parameter,
            paginationParamsString: JSON.stringify({
              limit: pageSize, offset, startRange: offset + 1, endRange: offset, totalRange: count,
              showRecords: pageSize, orderBy: '', order: '',
            }),
          };
          events.push(...parseMovements(await query('fetchProcessedEquipmentEventByContainerId', queryParameter)));
        }
        if (events.length < count) {
          throw new IndeterminateError(provider, 'Crowley returned an incomplete movement history', { reason: 'listed' });
        }
        return trackingResult(events);
      },
    }]);
  },
});
