import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AP_CARGO_MAX_BYTES, normalizeApCargoNumber, parseApCargo, PROVIDER } from './parser.js';

/** The lookup the tracking page on apcargo.com.ph makes for the waybill number its form reads. */
export const AP_CARGO_API = 'https://ojt8n5mafh.execute-api.ap-southeast-1.amazonaws.com/Prod/waybill-tracking';
/** The lookup of AP Cargo's older tracker, which still records deliveries. */
export const AP_CARGO_LEGACY_API = 'https://api.apcargo.com.ph/api/DeliveryStatus/external';
const REDIRECTS = [301, 302, 303, 307, 308];
// API Gateway's answer for a route it does not have.
const NO_ROUTE = /Missing Authentication Token/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|ERROR: The request could not be satisfied)|AwsWafIntegration|awswaf\.com|gokuProps|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'AP Cargo answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'AP Cargo returned a reply that is not JSON', { cause });
  }
}

export class ApCargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private get(url: string, signal: AbortSignal, timeoutMs: number, allowHttpStatuses: number[] = []) {
    return fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AP_CARGO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses });
  }

  /**
   * The tracker's reply. It answers with HTTP 200 even for a number it does
   * not hold; a rate limit or server error is the shared HTTP error for its status.
   */
  private async request(number: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await this.get(`${AP_CARGO_API}?waybillNumber=${encodeURIComponent(number)}`, signal, timeoutMs,
      [...REDIRECTS, 403, 404, 410]);
    const { status } = response;
    if (REDIRECTS.includes(status)) throw new TransportError(PROVIDER, 'AP Cargo tracking lookup is unavailable', { status });
    const body = decodeText(bytes);
    // A 403 is a block unless it is API Gateway's missing route; a 404 or 410 is a moved route unless it is a block page.
    if (status === 403 || status === 404 || status === 410) {
      const head = body.slice(0, 64_000);
      if (CHALLENGE.test(head) || (status === 403 && !NO_ROUTE.test(head))) throw new ChallengeError(PROVIDER, 'AP Cargo refused the lookup', { status });
      throw new TransportError(PROVIDER, 'AP Cargo tracking lookup is unavailable', { status });
    }
    return json(body);
  }

  /** The older tracker's reply, or null when it cannot give one: the tracker's answer stands without it. */
  private async legacy(number: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    try {
      const { bytes } = await this.get(`${AP_CARGO_LEGACY_API}?airwaybill=${encodeURIComponent(number)}`, signal, timeoutMs);
      return JSON.parse(decodeText(bytes));
    } catch {
      return null;
    }
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // Both trackers are asked at once; only the first decides whether the parcel is found.
    const [payload, legacy] = await Promise.all([this.request(number, signal, timeoutMs), this.legacy(number, signal, timeoutMs)]);
    return parseApCargo(payload, number, legacy);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeApCargoNumber(raw);
    // A read that fails to reach AP Cargo, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'ap-cargo', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ApCargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ap-cargo', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
