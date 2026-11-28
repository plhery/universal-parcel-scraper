import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bookingNotFound, bookingReference, normalizeEmiratesSkyCargoNumber, parseEmiratesSkyCargo, provider } from './parser.js';

const site = 'https://eskycargo.emirates.com';
const app = `${site}/app/offerandorder/`;
const signIn = `${site}/api/uaa/guest/oauth/token?productName=offerandorder`;
const orders = `${site}/api/order/services/cargo/v1/orders/`;
// eSkyCargo's script signs every visitor in as this public guest client, with an empty secret.
const guest = { tenant: 'EK', client_id: 'mercator', client_secret: '' };
const verification = /<title>\s*(?:Access Denied|Just a moment|Attention Required|Request Rejected)|cf-chl|_Incapsula_Resource|\/_sec\/cp_challenge/i;

const json = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(provider, 'Emirates SkyCargo returned unreadable JSON', { cause });
  }
};

/** The guest token's reply, or the reason there is none. */
export function guestToken(data: unknown): string {
  const token = isRecord(data) && typeof data.access_token === 'string' ? data.access_token : '';
  if (!/^[\w.~+/=-]{16,4096}$/.test(token) || String(isRecord(data) && data.token_type).toLowerCase() !== 'bearer') {
    throw new SchemaError(provider, 'eSkyCargo no longer signs guests in with a bearer token');
  }
  return token;
}

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeEmiratesSkyCargoNumber(input.number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const userAgent = userAgentOf(environment.userAgent);
        const read = async (url: string, init: RequestInit & { headers: Record<string, string> }, allowHttpStatuses: number[]) => {
          signal.throwIfAborted();
          const left = Math.floor(deadline - performance.now());
          if (left <= 0) throw new BudgetExceededError(provider, remainingMs);
          // The shared diagnostics redact the bearer header.
          const { response, bytes } = await fetchBounded(url, {
            ...init, signal,
            headers: { Accept: 'application/json, text/plain, */*', Origin: site, Referer: app, 'User-Agent': userAgent, ...init.headers },
          }, { provider, fetcher: environment.fetcher, timeoutMs: left, maxBytes: 1_000_000, allowHttpStatuses });
          const body = decodeText(bytes);
          if (response.status === 403 || verification.test(body)) throw new ChallengeError(provider, 'Emirates SkyCargo refused the request');
          // A 401 is the public guest client or its token turned down: a changed service.
          if (response.status === 401) throw new SchemaError(provider, 'Emirates SkyCargo refused its guest sign-in');
          return { status: response.status, body };
        };

        const session = await read(signIn, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Referer': 'https://EK' },
          body: new URLSearchParams(guest).toString(),
        }, [401, 403]);
        const authorization = `Bearer ${guestToken(json(session.body))}`;

        const search = await read(`${orders}actions/search?view=summary`, {
          method: 'POST',
          headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderFilter: { airCapacity: { documentNumbers: [number], includeItinerary: false } },
            pageRequest: { page: 1, pageSize: 10 },
          }),
        }, [401, 403, 404]);
        const found = json(search.body);
        if (search.status === 404) {
          // The page words it "There is no matching result found for your shipment reference."
          if (bookingNotFound(found)) throw new NotFoundError(provider, 'Emirates SkyCargo has no booking for this air waybill');
          throw new SchemaError(provider, 'Emirates SkyCargo no longer serves its shipment search there');
        }
        const reference = bookingReference(found, number);

        const booking = await read(`${orders}b${reference}`, { headers: { Authorization: authorization } }, [401, 403, 404]);
        if (booking.status === 404) throw new IndeterminateError(provider, 'Emirates SkyCargo found the booking but did not open it');
        return parseEmiratesSkyCargo(json(booking.body), number);
      },
    }]);
  },
});
