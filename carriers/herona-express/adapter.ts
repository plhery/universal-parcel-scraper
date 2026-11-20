import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { lookupBudget, type AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isChallenge, parseTracking, provider } from './parser.js';

const origin = 'https://tracking.heronaexpress.co.id';
const portal = `${origin}/lacak.php`;

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^(?:[A-Z]{4}\d{8}|\d{5})$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a Herona Express shipment number');
    }
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const budget = lookupBudget({ signal, budgetMs: remainingMs }, 15_000, provider);
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, new CookieJar());
        const headers = { 'User-Agent': userAgentOf(environment.userAgent) };
        const request = async (url: string, init: RequestInit) => {
          const { bytes } = await fetchBounded(url, { ...init, signal: budget.signal }, {
            provider, timeoutMs: budget.remainingMs(), maxBytes: 512 * 1024, fetcher,
          });
          return decodeText(bytes);
        };
        const page = await request(portal, { headers });
        if (isChallenge(page)) throw new ChallengeError(provider, 'Herona Express requires verification');
        const field = load(page)('input#track_token[type="hidden"]');
        const token = field.attr('value');
        if (field.length !== 1 || !token || !/^[a-f\d]{64}$/i.test(token)) {
          throw new SchemaError(provider, 'Missing the Herona Express guest form token');
        }
        return parseTracking(await request(`${origin}/ajax.php?action=get_parcel_heistory`, {
          method: 'POST',
          headers: { ...headers, Referer: portal, 'X-Requested-With': 'XMLHttpRequest' },
          body: new URLSearchParams({ ref_no: number, track_token: token }),
        }));
      },
    }]);
  },
});
