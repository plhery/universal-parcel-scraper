import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, readGuestForm } from './parser.js';

const carrier = 'rosalia-express';
const origin = 'https://www.rosalia-express.com';
const searchUrl = origin + '/cek-paket';
const endpoint = origin + '/livewire/message/front::float-card.tracking';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{1,12}$/.test(number)) {
      throw new InvalidInputError(carrier, 'Rosalia Express needs the shipment number printed on the receipt');
    }
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, new CookieJar());
        const headers = { 'User-Agent': userAgentOf(environment.userAgent) };
        const read = async (url: string, init: RequestInit) => {
          try {
            const { bytes } = await fetchBounded(url, { ...init, signal }, {
              provider: carrier, fetcher, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
              maxBytes: 512 * 1024, redirect: 'error',
            });
            return decodeText(bytes);
          } catch (error) {
            // Upstream diagnostics can include the transient guest form state.
            if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
            throw error;
          }
        };

        const html = await read(searchUrl, { headers: { ...headers, Accept: 'text/html' } });
        const { token, fingerprint, serverMemo } = readGuestForm(html);
        const body = JSON.stringify({
          fingerprint, serverMemo, updates: [
            { type: 'syncInput', payload: { id: 'receipt', name: 'receipt', value: number } },
            { type: 'callMethod', payload: { id: 'lookup', method: 'checkReceipts', params: [] } },
          ],
        });
        const reply = await read(endpoint, {
          method: 'POST',
          headers: {
            ...headers, Accept: 'text/html, application/xhtml+xml', 'Content-Type': 'application/json',
            Origin: origin, Referer: searchUrl, 'X-CSRF-TOKEN': token, 'X-Livewire': 'true',
          },
          body,
        });
        return parseTracking(reply, number);
      },
    }]);
  },
});
