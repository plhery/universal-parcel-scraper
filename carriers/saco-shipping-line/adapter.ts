import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseSearch, parseTracking, provider } from './parser.js';

const origin = 'https://sacoshipping.com';
const portal = origin + '/track/';
const endpoint = origin + '/wp-json/saco-tracking/v1/';

function trackingJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'SACO Shipping Line returned invalid tracking JSON');
  }
}

export const adapter: AdapterFactory = environment => ({
  id: provider, steps: ['direct'], recordsSteps: true,
  async track(input, context = {}) {
    const reference = input.number.trim().toUpperCase().replace(/^SSLL[ -]?/, '');
    if (!/^[A-Z0-9-]{5,36}$/.test(reference)) {
      throw new InvalidInputError(provider, 'Enter a SACO Shipping Line bill of lading');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 24_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const request = async (url: string, init: RequestInit, maxBytes: number) => {
          const { bytes, response } = await fetchBounded(url, { ...init, signal }, {
            provider, fetcher: environment.fetcher, timeoutMs: Math.max(1, deadline - performance.now()),
            maxBytes, allowHttpStatuses: [403],
          });
          const text = decodeText(bytes);
          if (response.status === 403 || /cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(text)) {
            throw new ChallengeError(provider, 'SACO Shipping Line requires verification');
          }
          return text;
        };

        const baseHeaders = { 'User-Agent': userAgentOf(environment.userAgent), Referer: portal };
        const page = await request(portal, { headers: { ...baseHeaders, Accept: 'text/html' } }, 550_000);
        const nonce = page.match(/\bsacoTracking\s*=\s*\{[^{}]{0,500}"nonce"\s*:\s*"([a-f\d]{10})"/i)?.[1];
        if (!nonce) throw new SchemaError(provider, 'SACO Shipping Line omitted the anonymous form state');

        const headers = { ...baseHeaders, 'X-WP-Nonce': nonce, Accept: 'application/json' };
        const search = trackingJson(await request(endpoint + 'search', {
          method: 'POST', headers: { ...headers, Origin: origin },
          body: new URLSearchParams({ type: 'BillofLadingNumber', reference }),
        }, 350_000));
        const shipment = parseSearch(search, reference);
        const events = trackingJson(await request(endpoint + 'events/' + shipment.id, { headers }, 550_000));
        return parseTracking(events, shipment);
      },
    }]);
  },
});
