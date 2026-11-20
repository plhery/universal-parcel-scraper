import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { hartrodtReference, parseHartrodtDetails, parseHartrodtSearch, PROVIDER, TRACKING_URL } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'a-hartrodt', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const reference = hartrodtReference(input.number);
    return runSteps({
      carrier: 'a-hartrodt', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const read = async (url: string | URL, options: RequestInit = {}): Promise<string> => {
          const { bytes, response } = await fetchBounded(url, {
            ...options, signal,
            headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
          }, {
            provider: PROVIDER, timeoutMs: Math.floor(remainingMs), maxBytes: 512_000,
            fetcher: environment.fetcher, redirect: 'error', allowHttpStatuses: [403],
          }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
          signal.throwIfAborted();
          const html = decodeText(bytes);
          if (response.status === 403 || /<title>\s*(?:Just a moment|Access denied)|cf-challenge|_cf_chl_opt/i.test(html.slice(0, 8192))) {
            throw new ChallengeError(PROVIDER);
          }
          return html;
        };

        const html = await read(TRACKING_URL, {
          method: 'POST',
          body: new URLSearchParams({
            search_shipment: '1', [reference.field]: reference.number, submit: ' Start search ',
          }),
        });
        const detail = new URL(TRACKING_URL);
        detail.searchParams.set('view_detail', parseHartrodtSearch(html, reference));
        return parseHartrodtDetails(await read(detail), reference);
      },
    }]);
  },
});
