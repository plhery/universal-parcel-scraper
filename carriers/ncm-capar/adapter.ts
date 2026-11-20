import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ncmNumber, parseNcmForm, parseNcmResult, PROVIDER } from './parser.js';

const ORIGIN = 'https://ncmcapar.az';
const TRACKING_URL = ORIGIN + '/az/tracking';
const ANONYMOUS_COOKIE = /^\.AspNetCore\.Antiforgery\.[A-Za-z0-9_-]{1,40}=[^\s;,]{1,1024}$/;

export const adapter: AdapterFactory = environment => ({
  id: 'ncm-capar', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = ncmNumber(input.number);
    return runSteps({
      carrier: 'ncm-capar', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const headers = { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'text/html', 'Accept-Language': 'az' };
        const options = {
          provider: PROVIDER, timeoutMs: Math.floor(remainingMs), maxBytes: 384_000,
          fetcher: environment.fetcher, redirect: 'error' as const, allowHttpStatuses: [400, 403],
        };
        const initial = await fetchBounded(TRACKING_URL, { headers, signal }, options)
          .catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        if (initial.response.status === 403) throw new ChallengeError(PROVIDER);
        if (initial.response.status !== 200) throw new IndeterminateError(PROVIDER, 'NCM Çapar tracking form was unavailable');

        const formState = parseNcmForm(decodeText(initial.bytes));
        const cookie = initial.response.headers.getSetCookie().map(header => header.split(';', 1)[0] ?? '')
          .find(pair => ANONYMOUS_COOKIE.test(pair));
        if (!cookie) throw new IndeterminateError(PROVIDER, 'NCM Çapar did not open an anonymous form session');

        const lookup = await fetchBounded(TRACKING_URL, {
          method: 'POST', signal,
          headers: { ...headers, Cookie: cookie, Origin: ORIGIN, Referer: TRACKING_URL },
          body: new URLSearchParams({ TrackingNumber: number, __RequestVerificationToken: formState }),
        }, options).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        if (lookup.response.status === 403) throw new ChallengeError(PROVIDER);
        if (lookup.response.status !== 200) throw new IndeterminateError(PROVIDER, 'NCM Çapar refused the tracking form');
        return parseNcmResult(decodeText(lookup.bytes), number);
      },
    }]);
  },
});
