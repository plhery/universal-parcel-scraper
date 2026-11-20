import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://www.pactracking.com/track/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const serial = /^(?:5YR[\s-]?)?(\d{8})$/i.exec(input.number.trim())?.[1];
    if (!serial) throw new InvalidInputError(provider, 'Enter the Pacific Air Cargo 5YR waybill or its eight-digit serial');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = portal + '?AwbPrefix=5YR&awb=' + serial;
        const { bytes, response } = await fetchBounded(url, {
          signal,
          headers: { Accept: 'text/html', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 350_000, allowHttpStatuses: [403],
        });
        const html = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|verify you are human/i.test(html)) {
          throw new ChallengeError(provider, 'Pacific Air Cargo requires verification');
        }
        return parseTracking(html, serial);
      },
    }]);
  },
});
