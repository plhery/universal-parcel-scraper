import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const query = `query Shipment($getShipmentByReferenceInput: GetShipmentByReferenceInput!) {
  shipment(getShipmentByReferenceInput: $getShipmentByReferenceInput) {
    shipmentReferenceId
    tracking { timestamp level0 { name } level1 { name } location }
  }
}`;

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim();
    if (!/^[A-Z0-9][A-Z0-9-]{3,63}$/i.test(reference)) {
      throw new InvalidInputError(provider, 'Enter a single Open360 shipment reference');
    }
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded('https://api.open360.com/tracking/graphql', {
          method: 'POST', signal, headers: {
            'User-Agent': userAgentOf(environment.userAgent), 'Content-Type': 'application/json',
            Origin: 'https://tracking.open360.com',
          },
          body: JSON.stringify({
            operationName: 'Shipment', query, variables: { getShipmentByReferenceInput: { shipmentReference: reference } },
          }),
        }, { provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, fetcher: environment.fetcher });
        if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(decodeText(bytes))) {
          throw new ChallengeError(provider, 'Open360 requires verification');
        }
        return parseTracking(parseJsonBytes(bytes, provider), reference);
      },
    }]);
  },
});
