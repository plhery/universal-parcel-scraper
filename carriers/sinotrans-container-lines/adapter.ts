import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseFormState, parseTracking, provider } from './parser.js';

const origin = 'https://ebusiness.sinolines.com.cn';
const portal = origin + '/Ebusiness/EQUERY/TrackingCargoE.aspx?subject=BLNO';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const container = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(container)) {
      throw new InvalidInputError(provider, 'Enter a Sinotrans Container Lines equipment number');
    }

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const headers = {
          Accept: 'text/html',
          'User-Agent': userAgentOf(environment.userAgent),
        };
        async function read(form?: URLSearchParams) {
          signal.throwIfAborted();
          const timeoutMs = Math.floor(deadline - performance.now());
          if (timeoutMs < 1) throw new BudgetExceededError(provider, remainingMs);
          const { response, bytes } = await fetchBounded(portal, {
            signal,
            ...(form
              ? { method: 'POST', body: form, headers: { ...headers, Origin: origin, Referer: portal } }
              : { headers }),
          }, { provider, fetcher: environment.fetcher, timeoutMs, maxBytes: 650_000, allowHttpStatuses: [403] });
          if (response.status === 403) throw new ChallengeError(provider, 'Sinotrans refused the container tracking request');
          return decodeText(bytes);
        }

        const form = parseFormState(await read());
        form.set('dl_seltype', 'cntrno');
        form.set('TbBlno', container);
        form.set('CNTRNOTXT', '');
        form.set('BlnoListRetrieveBT', 'Search');
        return parseTracking(await read(form), container);
      },
    }]);
  },
});
