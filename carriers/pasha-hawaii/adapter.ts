import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://www.pashahawaiishipping.com';
const portal = origin + '/public/track.htm';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim().toUpperCase();
    const container = /^[A-Z]{3}U\d{7}$/.test(reference);
    const bill = /^PHWC[A-Z0-9]{1,13}$/.test(reference) || /^\d{12}$/.test(reference);
    if (!container && !bill) {
      throw new InvalidInputError(provider, 'Enter an equipment number or a Pasha Hawaii bill of lading');
    }
    const number = container ? reference : reference.replace(/^PHWC/, '');
    const type = container ? 'EQ' : 'BL';
    const program = container ? 'WEQ001.PGM' : 'WCS001.PGM';
    const body = new URLSearchParams({ SCTYPE: type, SCREFN: number, SCPRIN: 'PA' });

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(origin + '/cgi-pas/' + program, {
          method: 'POST', body, signal,
          headers: { Accept: 'text/html', Origin: origin, Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 450_000, allowHttpStatuses: [403],
        });
        const html = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(html)) {
          throw new ChallengeError(provider, 'Pasha Hawaii requires verification');
        }
        return parseTracking(html, number, type);
      },
    }]);
  },
});
