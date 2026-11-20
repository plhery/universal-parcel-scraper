import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { AIR_INUIT_ORIGIN, airInuitUrl, airInuitWaybill, parseAirInuit, PROVIDER } from './parser.js';

export { AIR_INUIT_ORIGIN, airInuitUrl, airInuitWaybill, parseAirInuit } from './parser.js';
export type { AirInuitWaybill } from './parser.js';

const DEFAULT_BUDGET_MS = 15_000;
// A reply is under four kilobytes for a few lines of goods.
const MAX_BYTES = 512 * 1024;

export const adapter: AdapterFactory = (environment) => ({
  id: PROVIDER, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const waybill = airInuitWaybill(input.number);
    return runSteps({
      carrier: PROVIDER, recorder: environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(airInuitUrl(waybill), {
          signal, headers: {
            'User-Agent': userAgentOf(environment.userAgent), Accept: 'application/json',
            Referer: `${AIR_INUIT_ORIGIN}en/cargo/follow-up/shipment-tracking/your-shipment`,
          },
        }, { provider: PROVIDER, timeoutMs: remainingMs, maxBytes: MAX_BYTES, fetcher: environment.fetcher });
        // Cloudflare fronts the site.
        if (/cf-chl-|<title>\s*(?:Just a moment|Attention Required|Access denied)/i.test(decodeText(bytes))) {
          throw new ChallengeError(PROVIDER, 'Air Inuit requires verification');
        }
        return parseAirInuit(parseJsonBytes(bytes, PROVIDER), waybill);
      },
    }]);
  },
});
