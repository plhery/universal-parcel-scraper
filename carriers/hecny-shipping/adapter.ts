import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { ZEROSSL_RSA_DV_SSL_CA_2 } from './certificate.js';
import { parseTrackingPage, provider } from './parser.js';

const trackingUrl = 'https://www.hecny.com/en/track-and-trace';

let trusting: typeof fetch | undefined;
const trustingFetch = () => trusting ??= fetchTrusting([ZEROSSL_RSA_DV_SSL_CA_2]);

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = /^(?:HYSL[ -]?)?([A-Z]{4}\d{8})$/i.exec(input.number.trim())?.[1]?.toUpperCase();
    if (!number) throw new InvalidInputError(provider, 'Enter a Hecny house bill of lading number');
    const url = new URL(trackingUrl);
    url.searchParams.set('keyword', number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        // The public server omits its intermediate. A caller's own transport keeps its TLS policy.
        const fetcher = transportOf(environment.fetcher) === undefined ? trustingFetch() : environment.fetcher;
        const { bytes, response } = await fetchBounded(url.href, {
          headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, {
          provider, timeoutMs: remainingMs, fetcher, maxBytes: 500_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Hecny refused the tracking request');
        return parseTrackingPage(decodeText(bytes), number);
      },
    }]);
  },
});
