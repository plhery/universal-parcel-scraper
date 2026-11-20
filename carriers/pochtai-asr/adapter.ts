import { readerLanguage, type AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'pochtai-asr';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const suffix = /^ASR-?(\d{5,29})$/.exec(input.number.trim().toUpperCase())?.[1];
    if (!suffix) throw new InvalidInputError(carrier, 'Pochtai Asr requires its ASR waybill number');
    const number = 'ASR-' + suffix;
    const language = readerLanguage(input, ['en', 'ru', 'tg']) ?? 'en';

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded('https://apost.tj/api/v1/tracking/' + encodeURIComponent(number), {
          signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 512 * 1024,
          redirect: 'error', allowHttpStatuses: [404],
        });
        return parseTracking(decodeText(bytes), number, response.status, language);
      },
    }]);
  },
});
