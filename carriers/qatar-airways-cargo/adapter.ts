import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { guestContext, parseTracking, provider } from './parser.js';

const origin = 'https://www.qrcargo.com';
const page = '/s/track-your-shipment';
const endpoint = '/s/sfsites/aura';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '');
    if (!/^157\d{8}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Qatar Airways Cargo air waybill beginning with 157');
    const serial = number.slice(3);

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const options = {
          provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 600_000, allowHttpStatuses: [403],
        };
        const userAgent = userAgentOf(environment.userAgent);
        const landing = await fetchBounded(origin + page, {
          headers: { Accept: 'text/html', 'User-Agent': userAgent }, signal,
        }, options);
        if (landing.response.status === 403) throw new ChallengeError(provider, 'Qatar Airways Cargo refused its guest tracking page');
        const auraContext = guestContext(decodeText(landing.bytes));
        const actions = [{
          id: '1;a',
          descriptor: 'aura://ApexActionController/ACTION$execute',
          callingDescriptor: 'UNKNOWN',
          params: {
            namespace: '', classname: 'QCG_CTRL_TrackShipment', method: 'QCG_getAwbDetailsMS',
            params: { awbs: [{ documentType: 'MAWB', documentPrefix: '157', documentNumber: serial }] },
            cacheable: false, isContinuation: false,
          },
        }];
        const result = await fetchBounded(origin + endpoint, {
          method: 'POST', signal,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'User-Agent': userAgent, Origin: origin, Referer: origin + page,
          },
          body: new URLSearchParams({
            message: JSON.stringify({ actions }), 'aura.context': auraContext, 'aura.pageURI': page, 'aura.token': 'null',
          }),
        }, options);
        if (result.response.status === 403) throw new ChallengeError(provider, 'Qatar Airways Cargo refused the guest air waybill search');
        return parseTracking(decodeText(result.bytes), serial);
      },
    }]);
  },
});
