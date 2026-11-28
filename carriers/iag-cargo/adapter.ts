import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isIagCargoNotFound, normalizeIagCargoNumber, notFound, parseIagCargo, provider } from './parser.js';

const site = 'https://ui.tracking.iagcargo.com';
// The tracker's page asks this service for a waybill written with its dash, with no account, token or key.
const tracking = 'https://api.tracking.iagcargo.com/tracking/';
const verification = /<title>\s*(?:Access Denied|Just a moment|Attention Required|Request Rejected|Information Page)|cf-chl|_Incapsula_Resource|The request is blocked/i;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeIagCargoNumber(input.number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(tracking + number, {
          signal, headers: {
            Accept: 'application/json, text/plain, */*', Origin: site, Referer: site + '/', 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 600_000, allowHttpStatuses: [400, 403, 404] });
        const body = decodeText(bytes);
        if (response.status === 403 || verification.test(body)) throw new ChallengeError(provider, 'IAG Cargo refused the tracking request');
        // An unknown waybill comes back as a 404 whose text names it; any other 404 or a 400 is a changed service.
        if (response.status === 404) {
          if (isIagCargoNotFound(body, number)) notFound();
          throw new SchemaError(provider, 'IAG Cargo no longer serves its tracking there');
        }
        if (response.status === 400) throw new SchemaError(provider, 'IAG Cargo refused the air waybill as written');
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch (cause) {
          throw new SchemaError(provider, 'IAG Cargo returned unreadable tracking JSON', { cause });
        }
        return parseIagCargo(data, number);
      },
    }]);
  },
});
