import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://amcargo.aeromexico.com';
const endpoint = 'https://serv-amcargo.amsrvc.com/back-office/api/track/v3/139/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  steps: ['direct'],
  recordsSteps: true,
  async track(input, context = {}) {
    const number = input.number.trim().replace(/^139-/, '139');
    if (!/^139\d{8}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter an Aeroméxico Cargo air waybill with prefix 139');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + number.slice(3), {
          signal, headers: { Accept: 'application/json', Origin: portal, Referer: portal + '/track/',
            'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 500_000,
          allowHttpStatuses: [400, 403, 404, 422] });
        const body = decodeText(bytes);
        if (response.status === 403 || /cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
          throw new ChallengeError(provider, 'Aeroméxico Cargo requires verification');
        }
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'Aeroméxico Cargo returned invalid tracking JSON');
        }
        if (isRecord(data) && data.message === 'Track not found') throw new NotFoundError(provider);
        if (isRecord(data) && data.message === 'Track not information') {
          throw new IndeterminateError(provider, 'Aeroméxico Cargo gave no tracking details');
        }
        if (!response.ok || !isRecord(data) || typeof data.data !== 'string') {
          throw new SchemaError(provider, 'Aeroméxico Cargo omitted its air cargo status message');
        }
        return parseTracking(data.data, number);
      },
    }]);
  },
});
