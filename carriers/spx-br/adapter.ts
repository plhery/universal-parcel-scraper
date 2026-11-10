import { createHash } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpxBrNumber, parseSpxBr, parseSpxBrFleet, PROVIDER, SPX_BR_MAX_BYTES, spxBrShipment } from './parser.js';

/** The lookup the tracker on spx.com.br makes for the number in its address. */
export const SPX_BR_API = 'https://spx.com.br/shipment/order/open/order/get_order_info';
/** The fleet feed the tracker reads when its order lookup does not hold the number. */
export const SPX_BR_FLEET_API = 'https://spx.com.br/api/v2/fleet_order/tracking/search';
// Public checksum configuration of SPX's tracking clients, the same as the Taiwanese and
// Philippine trackers'; it is not a session credential.
const CHECKSUM_SALT = 'MGViZmZmZTYzZDJhNDgxY2Y1N2ZlN2Q1ZWJkYzlmZDY=';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The fleet feed's query: the number, the time in seconds and its checksum. */
export function spxBrFleetQuery(number: string, seconds: number): string {
  const checksum = createHash('sha256').update(`${number}${seconds}${CHECKSUM_SALT}`).digest('hex');
  return `${number}|${seconds}${checksum}`;
}

/** The reply as JSON; a web page in its place is a gateway's check, anything else a changed reply. */
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (/^\s*</.test(body)) throw new ChallengeError(PROVIDER, 'SPX Express Brazil answered with a web page instead of its tracking reply', { cause });
    throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a reply that is not JSON', { cause });
  }
}

export class SpxBrTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpxBrNumber(raw);
    const get = async (url: string, headers: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<unknown> => {
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent), ...headers,
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SPX_BR_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The tracker reads a missing parcel from a 200 reply; a 404 or a redirect is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'SPX Express Brazil tracking lookup is unavailable', { status: response.status });
      return json(decodeText(bytes));
    };
    // `pt` is the page's own language code: its wording names no recipient.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => parseSpxBr(await get(
      `${SPX_BR_API}?${new URLSearchParams({ spx_tn: number, language_code: 'pt' })}`, {}, signal, timeoutMs), number);
    // The page's Portuguese, as it asks for it. The feed knows a label by its shipment number alone.
    const fleet = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => parseSpxBrFleet(await get(
      `${SPX_BR_FLEET_API}?${new URLSearchParams({ sls_tracking_number: spxBrFleetQuery(spxBrShipment(number), Math.floor(Date.now() / 1000)) })}`,
      { 'x-language': 'br' }, signal, timeoutMs), number);
    return runSteps({ carrier: 'spx-br', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
      // An order the lookup does not hold, or one its index finds none of, can still be in the
      // fleet feed. Its own failure to answer leaves the lookup's.
      { id: 'legacy', recovers: (error) => error instanceof NotFoundError || error instanceof IndeterminateError && !(error instanceof NoHistoryError),
        run: async ({ signal, remainingMs, previousError }) => {
          try {
            return await fleet(signal, remainingMs);
          } catch (error) {
            throw error instanceof IndeterminateError && !(error instanceof NoHistoryError) ? previousError : error;
          }
        } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpxBrTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'spx-br', recordsSteps: true, steps: ['direct', 'legacy'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSpxBrNumber(number))),
  };
};
