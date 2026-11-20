import type { AdapterFactory } from '../../core/adapter/index.js';
import { SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSmartKargoNumber } from '../akasa-air-cargo/smartKargo.js';
import { parseTracking, provider, tracker } from './parser.js';
import { stageForWording } from './status.js';

const portal = { provider, tracker, prefix: '838', stageForWording };

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = normalizeSmartKargoNumber(input.number, portal);
    const url = new URL(tracker);
    url.search = new URLSearchParams({ AWBPrefix: reference.slice(0, 3), AWBNo: reference.slice(3) }).toString();
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const headers = { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'text/html' };
        const options = { provider, maxBytes: 512 * 1024, fetcher: environment.fetcher };
        const first = await fetchBounded(url, { signal, headers }, {
          ...options, timeoutMs: remainingMs, redirect: 'manual', allowHttpStatuses: [302],
        });
        if (first.response.status !== 302) return parseTracking(decodeText(first.bytes), reference);
        const location = first.response.headers.get('location');
        const result = location ? URL.parse(location, url) : null;
        if (!result || result.origin !== url.origin || result.pathname !== url.pathname
          || result.username || result.password || !result.searchParams.get('encrpt')
          || !result.searchParams.get('AWBPrefix') || !result.searchParams.get('AWBNo')) {
          throw new SchemaError(provider, 'Unexpected WestJet Cargo tracking redirect');
        }
        const { bytes } = await fetchBounded(result, { signal, headers }, {
          ...options, timeoutMs: Math.max(1, deadline - performance.now()),
        });
        return parseTracking(decodeText(bytes), reference);
      },
    }]);
  },
});
