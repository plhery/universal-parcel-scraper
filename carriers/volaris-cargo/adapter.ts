import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://volarisy4.smartkargo.com/FrmAWBTracking.aspx';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const serial = /^(?:036[\s-]?)?(\d{8})$/.exec(input.number.trim())?.[1];
    if (!serial) throw new InvalidInputError(provider, 'Enter the Volaris 036 air waybill or its eight-digit serial');
    return runSteps({
      carrier: provider,
      signal: context.signal,
      recorder: environment.recorder,
      budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = portal + '?AWBPrefix=036&AWBNo=' + serial;
        const read = (target: string) => fetchBounded(target, {
          signal,
          headers: { Accept: 'text/html', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider,
          fetcher: environment.fetcher,
          timeoutMs: remainingMs,
          maxBytes: 500_000,
          redirect: 'manual',
          allowHttpStatuses: [302, 403],
        });
        let reply = await read(url);
        if (reply.response.status === 302) {
          const location = reply.response.headers.get('location');
          const next = location && URL.parse(location, portal);
          if (!next || next.origin + next.pathname !== portal || next.username || next.password || next.href === url) {
            throw new TransportError(provider, 'Volaris Cargo redirected outside its tracking page');
          }
          reply = await read(next.href);
          if (reply.response.status === 302) {
            throw new TransportError(provider, 'Volaris Cargo redirected again during tracking');
          }
        }

        const html = decodeText(reply.bytes);
        if (reply.response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|verify you are human/i.test(html)) {
          throw new ChallengeError(provider, 'Volaris Cargo requires verification');
        }
        return parseTracking(html, '036' + serial);
      },
    }]);
  },
});
