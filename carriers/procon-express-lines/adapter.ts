import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const endpoint = 'https://www.cmslonline.com/fclasp76H/AspWtPublic.jsp';

export const adapter: AdapterFactory = environment => ({
  id: provider, steps: ['direct'], recordsSteps: true,
  async track(input, context = {}) {
    const reference = input.number.trim().toUpperCase().replace(/^PCXS[ -]?/, '');
    if (!/^[A-Z0-9]{5,35}$/.test(reference)) {
      throw new InvalidInputError(provider, 'Enter a Procon consignment reference or bill of lading');
    }
    const query = new URLSearchParams([
      ['imp', 'cms_cms'], ['imp', 'cms_cms_pt'], ['p_enquiry_ref', reference],
    ]);
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 16_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + '?' + query.toString(), {
          signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 850_000, allowHttpStatuses: [403],
        });
        const body = decodeText(bytes, 'windows-1252');
        if (response.status === 403 || /cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
          throw new ChallengeError(provider, 'Procon Express Lines requires verification');
        }
        return parseTracking(body, reference);
      },
    }]);
  },
});
