import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { deliboxNumber, parseDelibox, PROVIDER } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'delibox', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = deliboxNumber(input.number);
    const url = `https://www.dbox.co.kr/delivery.php?${new URLSearchParams({ laasInvcNo: number })}`;
    return runSteps({ carrier: 'delibox', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) } }, {
          provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 512_000, redirect: 'manual', fetcher: environment.fetcher,
        }).catch((error: unknown) => {
          signal.throwIfAborted();
          // The popup answers an unknown waybill with its alert, so a missing page is the site's fault.
          if (error instanceof UpstreamHttpError && error.kind === 'not_found') {
            throw new TransportError(PROVIDER, 'The Delibox tracking popup is unavailable', { status: error.status });
          }
          throw error;
        });
        signal.throwIfAborted();
        return parseDelibox(decodeText(bytes), number);
      },
    }]);
  },
});
