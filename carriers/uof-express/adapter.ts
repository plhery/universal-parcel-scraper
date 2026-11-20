import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { RTB56_MAX_BYTES, RTB56_REDIRECTS, rtb56Json, rtb56LookupUrl } from '../yypost/rtb56.js';
import { normalizeUofNumber, parseUof, PROVIDER } from './parser.js';

const ENDPOINT = 'https://oms.uofexp.com/webservice/Service.ashx';
const CALLBACK = 'trackingCallback';

export const adapter: AdapterFactory = (environment) => ({
  id: 'uof-express',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context) {
    context?.signal?.throwIfAborted();
    const number = normalizeUofNumber(input.number);
    return runSteps({
      carrier: 'uof-express',
      budgetMs: context?.budgetMs ?? 15_000,
      signal: context?.signal,
      recorder: environment.recorder,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = new URL(rtb56LookupUrl(ENDPOINT, CALLBACK, number));
        url.searchParams.set('_', String(Date.now()));
        const { response, bytes } = await fetchBounded(url, {
          signal,
          headers: {
            Accept: 'text/javascript, application/javascript, */*; q=0.01',
            Referer: 'https://www.uofexp.com/',
            'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider: PROVIDER,
          timeoutMs: remainingMs,
          maxBytes: RTB56_MAX_BYTES,
          redirect: 'manual',
          allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410],
          fetcher: environment.fetcher,
        });
        signal.throwIfAborted();
        if (response.status !== 200) {
          throw new TransportError(PROVIDER, 'UOF International tracking lookup did not return HTTP 200', { status: response.status });
        }
        return parseUof(rtb56Json(decodeText(bytes), CALLBACK, PROVIDER), number);
      },
    }]);
  },
});
