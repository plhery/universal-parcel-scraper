import { createHash, randomUUID } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeRunforintNumber, parseRunforint, PROVIDER, RUNFORINT_MAX_BYTES, runforintJson } from './parser.js';

/** The tracking page, which looks up the number in its `key` parameter. */
export const RUNFORINT_PAGE = 'https://www.runforint.com/index.php?m=home&c=Lists&a=index&tid=137';
/** The lookup the page posts to. */
export const RUNFORINT_API = 'https://www.runforint.com/index.php?m=home&c=index&a=waybill_track';
/** The system name the page sends. */
export const RUNFORINT_SYSTEM = 'runforint';
// The key the page's script signs every visitor's request with, the same for everyone.
const RUNFORINT_KEY = '5NbKkcXd2XpsjMX7NQwPcQkj4dBJTW5T'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * The page's request for one number: the list as Base64 JSON, the time in
 * seconds and a fresh message id, signed with the MD5 of those fields and the
 * page's key.
 */
export function runforintRequest(number: string, now = Date.now(), messageId: string = randomUUID()): URLSearchParams {
  const fields = { SystemCode: RUNFORINT_SYSTEM, Data: Buffer.from(JSON.stringify({ ShipmentNoList: [number] })).toString('base64'),
    Timestamp: String(Math.floor(now / 1000)), MessageId: messageId, UserName: '' };
  const signed = `Data=${fields.Data}&Key=${RUNFORINT_KEY}&MessageId=${fields.MessageId}&SystemCode=${fields.SystemCode}`
    + `&Timestamp=${fields.Timestamp}&UserName=${fields.UserName}`;
  return new URLSearchParams({ Signature: createHash('md5').update(signed).digest('hex'), ...fields });
}

export class RunforintTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeRunforintNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The number alone, with no session, token or account.
      const { response, bytes } = await fetchBounded(RUNFORINT_API, { method: 'POST', signal, body: runforintRequest(number).toString(),
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', Referer: `${RUNFORINT_PAGE}&${new URLSearchParams({ key: number })}`,
          'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: RUNFORINT_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Runforint tracking lookup is unavailable', { status: response.status });
      return parseRunforint(runforintJson(decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RunforintTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeRunforintNumber(number))),
  };
};
