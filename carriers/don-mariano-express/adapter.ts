import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://www.don-mariano.com';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const identifier = input.number.trim().toUpperCase();
    const guide = /^\d{1,11}$/.test(identifier);
    const code = /^FLET-?(\d{10})-?([A-Z]\d{3})$/.exec(identifier);
    if (!guide && !code) throw new InvalidInputError(provider, 'Enter a Don Mariano guide or Seguimiento code');
    const number = code ? 'FLET-' + code[1] + '-' + code[2] : identifier;
    const url = new URL('/tracking', origin);
    url.searchParams.set(guide ? 'cargaID' : 'codSeguimiento', number);

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          signal,
          headers: { Accept: 'text/html', Referer: origin + '/', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 450_000, allowHttpStatuses: [403],
        });
        const html = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(html)) {
          throw new ChallengeError(provider, 'Don Mariano Express requires verification');
        }
        return parseTracking(html, number, guide);
      },
    }]);
  },
});
