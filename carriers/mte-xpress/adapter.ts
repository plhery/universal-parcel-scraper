import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseMteXpress, PROVIDER, PROVIDER_ID } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'mte-xpress',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Invalid tracking reference');
    return runSteps({ carrier: 'mte-xpress', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const url = new URL('https://api.portal.mtexpress.co.za/tracking/shipments');
      url.searchParams.set('tracking_reference', number);
      url.searchParams.set('provider_id', String(PROVIDER_ID));
      const { response, bytes } = await fetchBounded(url, {
        signal, headers: { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'application/json' },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 512_000,
        allowHttpStatuses: [404], fetcher: environment.fetcher });
      const body = decodeText(bytes);
      if (/<title>\s*Just a moment|_cf_chl_opt|AwsWafIntegration/i.test(body.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'MTE Xpress returned a browser check');
      }
      if (response.status === 404) {
        if (body.trim() === 'could not find shipment or parcel with reference ' + number) throw new NotFoundError(PROVIDER);
        throw new IndeterminateError(PROVIDER, 'MTE Xpress tracking endpoint returned HTTP 404');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        throw new SchemaError(PROVIDER, 'MTE Xpress returned invalid JSON', { cause });
      }
      return parseMteXpress(payload, number);
    } }]);
  },
});
