import { load } from 'cheerio';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider, rejectChallenge } from './parser.js';

const origin = 'https://xanhthl.com';
const portal = origin + '/';
const endpoint = portal + 'wp-admin/admin-ajax.php';

function guestNonce(source: string): string | undefined {
  return source.match(/\bxanhTrackingConfig\s*=\s*\{[^{}]{0,500}["']nonce["']\s*:\s*["']([a-f\d]{10})["']/i)?.[1];
}

function guestBundle(page: string): URL {
  const $ = load(page);
  const bundles = $('script[data-src], script[src]').toArray().flatMap(element => {
    const path = $(element).attr('data-src') ?? $(element).attr('src') ?? '';
    try {
      const url = new URL(path, portal);
      return url.origin === origin && /^\/wp-content\/litespeed\/js\/[a-f\d]{32}\.js$/i.test(url.pathname)
        ? [url] : [];
    } catch {
      return [];
    }
  });
  if (bundles.length !== 1) throw new SchemaError(provider, 'Xanh THL omitted the guest form script');
  return bundles[0]!;
}

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^[A-Za-z0-9-]{1,50}$/.test(number)) throw new InvalidInputError(provider, 'Enter the Xanh THL waybill');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 30_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const userAgent = userAgentOf(environment.userAgent);
        const options = { provider, fetcher: environment.fetcher, allowHttpStatuses: [403] };
        const remaining = () => Math.max(1, deadline - performance.now());
        const get = async (url: string | URL, accept: string, maxBytes: number) => {
          const { bytes, response } = await fetchBounded(url, {
            headers: { Accept: accept, Referer: portal, 'User-Agent': userAgent }, signal,
          }, { ...options, timeoutMs: remaining(), maxBytes });
          if (response.status === 403) throw new ChallengeError(provider, 'Xanh THL refused the guest form');
          const source = decodeText(bytes);
          rejectChallenge(source);
          return source;
        };
        const page = await get(portal, 'text/html', 900_000);
        const nonce = guestNonce(page) ?? guestNonce(await get(guestBundle(page), 'application/javascript', 2_500_000));
        if (!nonce) throw new SchemaError(provider, 'Xanh THL omitted the anonymous form state');

        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json', Origin: origin, Referer: portal,
            Connection: 'close', 'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': userAgent, 'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams({ action: 'xanh_get_tracking', nonce, code: number }),
          signal,
        }, { ...options, timeoutMs: remaining(), maxBytes: 650_000 });
        if (response.status === 403) throw new ChallengeError(provider, 'Xanh THL refused the guest lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
