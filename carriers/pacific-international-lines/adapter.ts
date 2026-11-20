import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseFormState, parseTracking, provider } from './parser.js';

const origin = 'https://www.pilship.com';
const portal = origin + '/digital-solutions/?tab=customer&id=track-trace';
const api = origin + '/wp-content/themes/hello-theme-child-master/pil-api/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const container = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(container)) throw new InvalidInputError(provider, 'Enter a PIL container number');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const timestamp = String(Date.now());
        const headers = {
          Accept: 'application/json', Referer: portal, 'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': userAgentOf(environment.userAgent),
        };
        const read = async (path: string, query: Record<string, string>) => {
          signal.throwIfAborted();
          const timeoutMs = Math.floor(deadline - performance.now());
          if (timeoutMs < 1) throw new BudgetExceededError(provider, remainingMs);
          const url = new URL(path, api);
          url.search = new URLSearchParams(query).toString();
          const { bytes, response } = await fetchBounded(url.href, { headers, signal }, {
            provider, timeoutMs, fetcher: environment.fetcher, maxBytes: 400_000, allowHttpStatuses: [403],
          });
          if (response.status === 403) throw new ChallengeError(provider, 'PIL refused the cargo tracking request');
          return decodeText(bytes);
        };
        const n = parseFormState(await read('common/get-n.php', { timestamp }));
        return parseTracking(await read('trackntrace-containertnt.php', {
          module: 'TrackContStatus', refNo: container, n, timestamp,
        }), container);
      },
    }]);
  },
});
