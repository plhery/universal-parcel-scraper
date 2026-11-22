import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { activityRequest, guestToken, loginRequest, normalizeWaybill, parseTracking, provider, summaryRequest } from './parser.js';

const origin = 'https://icargowebportal.china-airlines.com';
const endpoint = origin + '/portalgateway/graphql';
const referer = origin + '/icargoneoportal/app/main/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const waybill = normalizeWaybill(input.number);

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const options = { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 600_000, allowHttpStatuses: [403] };
        const headers = {
          Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin, Referer: referer,
          'User-Agent': userAgentOf(environment.userAgent),
        };
        const post = async (body: object, token?: string) => {
          const { bytes, response } = await fetchBounded(endpoint, {
            method: 'POST', signal, body: JSON.stringify(body),
            headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
          }, options);
          if (response.status === 403) throw new ChallengeError(provider, 'China Airlines Cargo refused the guest tracking request');
          return decodeText(bytes);
        };
        // The portal's guest sign-in opens an anonymous session; the gateway answers only the portal's named operations.
        const token = guestToken(await post(loginRequest));
        const [summary, activity] = await Promise.all([post(summaryRequest(waybill), token), post(activityRequest(waybill), token)]);
        return parseTracking(summary, activity, waybill);
      },
    }]);
  },
});
