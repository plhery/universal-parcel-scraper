import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(number)) throw new InvalidInputError(provider, 'Enter one Relay Express docket number');
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = `https://scm.relayexpress.in/CustomerDocketTrack/CustomerTrackkNew?DocketNumber=${encodeURIComponent(number)}&Captcha=&CaptchaHash=`;
        const { bytes } = await fetchBounded(url, {
          signal, headers: {
            'User-Agent': userAgentOf(environment.userAgent), 'X-Requested-With': 'XMLHttpRequest',
            Referer: 'https://scm.relayexpress.in/DocketTrack',
          },
        }, { provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, fetcher: environment.fetcher });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
