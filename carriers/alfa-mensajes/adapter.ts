import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://alfamensajes.com/';
const endpoint = 'https://api.dimail.co/api/v1/public/notificaciones/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^NF\d{9}$/.test(number)) throw new InvalidInputError(provider, 'Enter an Alfa Mensajes physical NF guide');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(`${endpoint}${number}`, {
          headers: { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) }, signal,
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 600_000, allowHttpStatuses: [403, 404] });
        if (response.status === 403) throw new ChallengeError(provider, 'Alfa Mensajes refused the guide search');
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
