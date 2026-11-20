import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { formState, parseTracking, provider, verifySearch } from './parser.js';

const origin = 'https://guias.cadena.com.co';
const portal = origin + '/tracking/consulta.aspx';
const lookup = 'ctl00$MainPane$LeftPane$leftContent$txconsulta';
const search = 'ctl00$MainPane$LeftPane$leftContent$Button1';
const detail = 'ctl00$MainPane$MainContent$cpnl_vistas';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{1,20}$/.test(number)) throw new InvalidInputError(provider, 'Enter a numeric Cadena Courier guide');

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, new CookieJar());
        const headers = { Accept: 'text/html, */*', 'User-Agent': userAgentOf(environment.userAgent), Referer: portal, Origin: origin };
        async function read(body?: URLSearchParams): Promise<string> {
          const { bytes, response } = await fetchBounded(portal, {
            headers, signal, ...(body && { method: 'POST', body }),
          }, {
            provider, fetcher, timeoutMs: remainingMs, maxBytes: 550_000, allowHttpStatuses: [403],
          });
          if (response.status === 403) throw new ChallengeError(provider, 'Cadena Courier refused the public guide lookup');
          return decodeText(bytes);
        }

        const searchFields = formState(await read());
        searchFields.set(lookup, number);
        searchFields.set(search, 'Buscar');
        const result = await read(searchFields);
        verifySearch(result, number);

        const detailFields = formState(result);
        detailFields.set(lookup, number);
        detailFields.set('__CALLBACKID', detail);
        detailFields.set('__CALLBACKPARAM', 'c0:');
        return parseTracking(await read(detailFields), number);
      },
    }]);
  },
});
