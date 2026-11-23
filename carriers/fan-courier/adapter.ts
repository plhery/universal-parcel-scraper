import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { ChallengeError, IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean, decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeFanCourierNumber, parseFanCourier, PROVIDER } from './parser.js';

/** The tracking page's own lookup, which it posts as a form. */
const ENDPOINT = 'https://www.fancourier.ro/limit-tracking.php';
// Cloudflare's interstitial, served with a 200 or a 403.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required)|\bcf[-_]chl|challenge-platform/i;

/** The message of a rejected lookup's JSON reply, for diagnostics. */
function rejection(bytes: Uint8Array): string {
  let payload: unknown;
  try { payload = parseJsonBytes(bytes.subarray(0, 4_096), PROVIDER); } catch { return ''; }
  const message = isRecord(payload) ? clean(payload.message, 120).replace(/\d{6,}/g, '#') : '';
  return message ? `: ${message}` : '';
}

/**
 * Whether a 404 is FAN's "The AWB has been registered by sender": the sender's label, before FAN has the
 * parcel. A reply naming another AWB in `content` is not that answer for this one.
 */
function registeredBySender(bytes: Uint8Array, number: string): boolean {
  let payload: unknown;
  try { payload = parseJsonBytes(bytes.subarray(0, 4_096), PROVIDER); } catch { return false; }
  if (!isRecord(payload) || typeof payload.message !== 'string') return false;
  if (payload.content !== undefined && payload.content !== null && returnedTrackingNumber(payload.content, true) !== number) return false;
  return payload.message.trim().replace(/\.$/, '').toLowerCase() === 'the awb has been registered by sender';
}

export class FanCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeFanCourierNumber(raw);
    return runSteps({ carrier: 'fan-courier', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
        // The English page's locale, which words the events in English.
        body: new URLSearchParams({ action: 'get_awb', awb: number, lang: 'en-US' }),
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404, 422], fetcher: this.options.fetcher });
      // The number was checked before the request: a rejection or a missing page says nothing about the parcel.
      // The tracking page shows the message FAN sends with it, which the diagnostics keep, without long digit runs.
      if (response.status === 404 && registeredBySender(bytes, number)) {
        throw new NoHistoryError(PROVIDER, 'FAN Courier lists the AWB as registered by its sender, before it has the parcel', { reason: 'listed' });
      }
      if (response.status !== 200) {
        throw new IndeterminateError(PROVIDER, `FAN Courier tracking is unavailable (HTTP ${response.status}${rejection(bytes)})`);
      }
      const text = decodeText(bytes.subarray(0, 4_096));
      if (CHALLENGE.test(text)) throw new ChallengeError(PROVIDER, 'FAN Courier asked for a browser check');
      // The page asks again after an empty reply, as after a rate limit.
      if (!text.trim()) throw new IndeterminateError(PROVIDER, 'FAN Courier returned an empty reply');
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'FAN Courier returned invalid tracking JSON', { cause }); }
      return parseFanCourier(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new FanCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'fan-courier', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    // An AWB its sender registered is FAN's own number, known before the parcel's first scan.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFanCourierNumber(number))).catch((error: unknown) => {
      if (error instanceof NoHistoryError && error.reason === 'listed') return { known: true, lastActivityAt: null };
      throw error;
    }) };
};
