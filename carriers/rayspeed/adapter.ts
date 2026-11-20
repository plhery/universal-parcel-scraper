import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { lookupBudget, type AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isBlocked, parseTracking, provider } from './parser.js';

const origin = 'https://rayspeed.com';
const portal = `${origin}/en/track`;

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(number)) throw new InvalidInputError(provider, 'Enter one RaySpeed Asia waybill');
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const budget = lookupBudget({ signal, budgetMs: remainingMs }, 15_000, provider);
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, new CookieJar());
        const userAgent = userAgentOf(environment.userAgent);
        const request = async (url: string, init: RequestInit) => {
          const { bytes } = await fetchBounded(url, { ...init, signal: budget.signal }, {
            provider, timeoutMs: budget.remainingMs(), maxBytes: 512 * 1024, fetcher,
          });
          return decodeText(bytes);
        };
        const page = await request(portal, {
          headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' },
        });
        if (isBlocked(page)) throw new ChallengeError(provider, 'RaySpeed requires verification');
        const token = /\bconst csrfToken\s*=\s*["']([A-Za-z0-9]{40})["']/.exec(page)?.[1];
        if (!token) throw new SchemaError(provider, 'Missing RaySpeed guest form token');
        const body = await request(`${origin}/ajax/track-awbs`, {
          method: 'POST', body: new URLSearchParams({ 'awbs[]': number }),
          headers: { 'User-Agent': userAgent, Accept: 'application/json', 'X-CSRF-TOKEN': token, Origin: origin, Referer: portal },
        });
        return parseTracking(body, number);
      },
    }]);
  },
});
