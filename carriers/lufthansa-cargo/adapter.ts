import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeLufthansaCargoNumber, parseLufthansaCargo, provider } from './parser.js';

const site = 'https://www.lufthansa-cargo.com';
// The eTracking page's script asks this service for a waybill, with no account, token or key.
const details = 'https://api-external.lufthansa-cargo.com/stp/shipments-details/';
const verification = /<title>\s*(?:Access Denied|Just a moment|Attention Required|Request Rejected)|cf-chl|_Incapsula_Resource|Azure WAF|The request is blocked/i;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeLufthansaCargoNumber(input.number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(details + number, {
          signal, headers: {
            Accept: 'application/json', Origin: site, Referer: site + '/', 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 600_000, allowHttpStatuses: [403, 404] });
        const body = decodeText(bytes);
        if (response.status === 403 || verification.test(body)) throw new ChallengeError(provider, 'Lufthansa Cargo refused the tracking request');
        // The service answers an unknown waybill with HTTP 200; a 404 is a moved service.
        if (response.status === 404) throw new SchemaError(provider, 'Lufthansa Cargo no longer serves its shipment details there');
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch (cause) {
          throw new SchemaError(provider, 'Lufthansa Cargo returned unreadable tracking JSON', { cause });
        }
        return parseLufthansaCargo(data, number);
      },
    }]);
  },
});
