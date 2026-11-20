import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError, NotFoundError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, readForm, SEARCH_URL } from './parser.js';

const carrier = 'cootranstame';
const origin = 'https://www.cootranstame.com';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{1,20}$/.test(number)) {
      throw new InvalidInputError(carrier, 'CootransTame requires the numeric guide from the shipping receipt');
    }

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, new CookieJar());
        const commonHeaders = { 'Accept-Language': 'es-CO', 'User-Agent': userAgentOf(environment.userAgent) };
        const read = async (url: string, init: RequestInit) => {
          try {
            const { bytes } = await fetchBounded(url, { ...init, signal }, {
              provider: carrier, fetcher, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
              maxBytes: 1024 * 1024, redirect: 'error',
            });
            return decodeText(bytes);
          } catch (error) {
            // Omit the guest form snapshot, cookies and CSRF header from transport diagnostics.
            if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
            if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
            throw error;
          }
        };

        const form = await read(SEARCH_URL, { headers: { ...commonHeaders, Accept: 'text/html' } });
        const { token, fingerprint, serverMemo } = readForm(form);
        const submit = async (service: string) => {
          const response = await read(origin + '/livewire/message/traza-guia', {
            method: 'POST',
            headers: {
              ...commonHeaders, Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin,
              Referer: SEARCH_URL, 'X-CSRF-TOKEN': token, 'X-Livewire': 'true',
            },
            body: JSON.stringify({ fingerprint, serverMemo, updates: [
              { type: 'syncInput', payload: { id: 'a1a1', name: 'guia', value: number } },
              { type: 'syncInput', payload: { id: 'a1a2', name: 'tipoServicio', value: service } },
              { type: 'callMethod', payload: { id: 'a1a3', method: 'sendForm', params: [] } },
            ] }),
          });
          return parseTracking(response, number, service);
        };

        try {
          return await submit('110');
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          return submit('111');
        }
      },
    }]);
  },
});
