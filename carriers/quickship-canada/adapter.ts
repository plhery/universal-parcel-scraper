import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://track.quickshipnow.com';
const endpoint = 'https://qsapi.quickshipnow.com/public/track';
const absent = 'No tracking information found for the provided AWB number.';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{3,44}[A-Z0-9]$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a QuickShip air waybill number');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const query = new URLSearchParams({ awb: number, origin: new URL(portal).hostname });
        const { bytes, response } = await fetchBounded(endpoint + '?' + query.toString(), {
          signal, headers: {
            Accept: 'application/json', Origin: portal, Referer: portal + '/', 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 600_000, allowHttpStatuses: [400, 403],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl/i.test(body)) {
          throw new ChallengeError(provider, 'QuickShip requires verification');
        }
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'QuickShip returned invalid tracking JSON');
        }
        if (isRecord(data) && data.success === false && data.errorCode === 'ERR_VALIDATION' && data.message === absent) {
          throw new NotFoundError(provider);
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
