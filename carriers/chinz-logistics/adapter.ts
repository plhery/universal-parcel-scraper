import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { chinzNumber, parseChinz, PROVIDER } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'chinz-logistics', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = chinzNumber(input.number);
    const url = `https://nz-cn.parcelmate.vip/api/comm/order/logic?${new URLSearchParams({ ordersns: number })}`;
    return runSteps({ carrier: 'chinz-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) } }, {
          provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 512_000, redirect: 'manual', fetcher: environment.fetcher,
        }).catch((error: unknown) => {
          signal.throwIfAborted();
          // The API answers an unknown order in its JSON body, so a missing endpoint is the site's fault.
          if (error instanceof UpstreamHttpError && error.kind === 'not_found') {
            throw new TransportError(PROVIDER, 'The Chinz Logistics tracking API is unavailable', { status: error.status });
          }
          throw error;
        });
        signal.throwIfAborted();
        const body = decodeText(bytes.subarray(0, 8192)).trimStart();
        if (body.startsWith('<') && /_cf_chl_opt|cf-challenge|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(body)) {
          throw new ChallengeError(PROVIDER);
        }
        return parseChinz(parseJsonBytes(bytes, PROVIDER), number);
      },
    }]);
  },
});
