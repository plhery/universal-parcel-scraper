import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CALLBACK, fastwayLabel, parseFastwayReply, PROVIDER } from './parser.js';

const ORIGIN = 'https://www.fastway.co.za';
const UNAVAILABLE = [301, 302, 303, 307, 308, 404, 410];

export const adapter: AdapterFactory = environment => ({
  id: 'fastway-za',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = fastwayLabel(input.number);
    const url = new URL('/tracking-api21/', ORIGIN);
    url.search = new URLSearchParams({ callback: CALLBACK, LabelNo: number }).toString();
    return runSteps({ carrier: 'fastway-za', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(url.toString(), {
          signal, headers: { Accept: 'application/javascript, application/json',
            Referer: `${ORIGIN}/our-services/track-your-parcel/`, 'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 600_000,
          redirect: 'manual', fetcher: environment.fetcher, allowHttpStatuses: UNAVAILABLE });
        signal.throwIfAborted();
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Fastway tracking endpoint is unavailable', { status: response.status });
        return parseFastwayReply(decodeText(bytes), number);
      },
    }]);
  },
});
