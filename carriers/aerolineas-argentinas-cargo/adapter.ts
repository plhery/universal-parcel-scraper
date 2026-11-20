import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://aerolineas.smartkargo.com/FrmAWBTracking.aspx';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const serial = /^(?:044-?)?(\d{8})$/.exec(input.number.trim())?.[1];
    if (!serial) throw new InvalidInputError(provider, 'Enter the eight-digit Aerolíneas Cargo serial, optionally preceded by 044');
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = portal + '?AWBPrefix=044&AWBNo=' + serial;
        const { bytes, response } = await fetchBounded(url, {
          signal, headers: {
            Accept: 'text/html', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 480_000, allowHttpStatuses: [403],
        });
        const html = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl/i.test(html)) {
          throw new ChallengeError(provider, 'Aerolíneas Argentinas Cargo requires verification');
        }
        return parseTracking(html, serial);
      },
    }]);
  },
});
