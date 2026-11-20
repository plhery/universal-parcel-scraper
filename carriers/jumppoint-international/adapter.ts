import { accepted, recognizeFromBrowserLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, InvalidInputError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jumppointInternationalStage } from './status.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

const PROVIDER = 'Jumppoint International Express';
export const JUMPPOINT_INTERNATIONAL_API = 'https://int-tracking-api.jumppoint.io/shipment/tracking/';
const CAPTCHA = new Set(['RESPONSE_TOKEN_MISSING', 'RECAPTHA_VERIFICATION_FAIL', 'RECAPTCHA_VERIFICIATION_PROCESS_ERROR']);

export function normalizeJumppointInternationalNumber(raw: string): string {
  const number = raw.length <= 64 ? raw.toUpperCase().replace(/[\s.-]/g, '') : '';
  if (!/^JP[A-Z]{2}\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Jumppoint International requires JP, two letters and ten digits');
  return number;
}

export function jumppointInternationalUrl(raw: string): string {
  return 'https://int-tracking.jumppoint.io/?q=' + normalizeJumppointInternationalNumber(raw);
}

function label(value: unknown): string {
  if (!isRecord(value)) return '';
  for (const key of ['en', 'zh', 'cn']) { const text = clean(value[key], 500); if (text) return text; }
  return '';
}

/** The international portal returns translated labels, not the domestic portal's status codes. */
export function parseJumppointInternational(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJumppointInternationalNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Jumppoint International returned an invalid envelope');
  if (!payload.success) {
    const error = isRecord(payload.error) ? payload.error : {};
    if (CAPTCHA.has(String(error.user_message ?? error.code))) throw new ChallengeError(PROVIDER, 'Jumppoint International refused reCAPTCHA verification');
    throw new IndeterminateError(PROVIDER, 'Jumppoint International did not complete tracking');
  }
  const rows = isRecord(payload.data) ? payload.data.trackings : null;
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0]) || rows[0].trackingNumber !== number) {
    throw new SchemaError(PROVIDER, 'Jumppoint International returned another or ambiguous shipment');
  }
  const row = rows[0];
  if (!Array.isArray(row.statusLogs) || row.statusLogs.length > 500) throw new SchemaError(PROVIDER, 'Jumppoint International returned an invalid history');
  // The guest API echoes even an unissued number. An empty echo is not carrier ownership or final absence.
  if (!row.statusLogs.length) throw new IndeterminateError(PROVIDER, 'Jumppoint International returned no shipment history', { reason: 'empty_history' });
  const events: CarrierEvent[] = row.statusLogs.map(value => {
    if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Jumppoint International returned an invalid scan');
    const description = label(value.statusCode);
    const rawTime = typeof value.eventDate === 'string' ? value.eventDate : '';
    const instant = explicitOffsetTime(rawTime);
    if (!description || !instant) throw new SchemaError(PROVIDER, 'Jumppoint International returned an undated or unlabelled scan');
    const stage = jumppointInternationalStage(description);
    return { time: instant.iso, description,
      ...(stage.source !== 'none' ? { stage: stage.stage, stage_source: stage.source } : {}) };
  });
  // The API supplies instants, so sort across offices without inferring a facility zone.
  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const newest = events[0]!;
  const headed = jumppointInternationalStage(label(row.status));
  const stage = (headed.source !== 'none' ? headed.stage : events.find(event => event.stage)?.stage) as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: headed.source !== 'none' ? headed.source : events.find(event => event.stage)?.stage_source } : {}),
    last_status_text: label(row.status) || newest.description,
    last_update: newest.time ?? null,
    expected_delivery: null, ...(stage === 'delivered' && events.find(event => event.stage === 'delivered')?.time
      ? { delivered_at: events.find(event => event.stage === 'delivered')!.time } : {}), events };
}

function boundCapture(url: string, number: string): boolean {
  try {
    const u = new URL(url);
    const numbers = u.searchParams.getAll('trackingNumbers[]');
    const alternate = u.searchParams.getAll('trackingNumbers');
    const selected = numbers.length && !alternate.length ? numbers : !numbers.length ? alternate : [];
    return u.origin + u.pathname === JUMPPOINT_INTERNATIONAL_API && !u.username && !u.password && !u.hash
      && selected.length === 1 && selected[0] === number
      && [...u.searchParams.keys()].every(key => ['trackingNumbers[]', 'trackingNumbers', 'captchaToken', 'locale'].includes(key));
  } catch { return false; }
}

export class JumppointInternationalTracker {
  constructor(private readonly options: { trawl: TrawlClient | null; recorder?: StepRecorder }) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJumppointInternationalNumber(raw);
    return runSteps({ carrier: 'jumppoint-international', budgetMs: context.budgetMs ?? 45_000,
      signal: context.signal, recorder: this.options.recorder }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const timeoutMs = Math.floor(remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS);
      if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
      if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'Jumppoint International requires the browser tracking service');
      const url = jumppointInternationalUrl(number);
      const page = await this.options.trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [JUMPPOINT_INTERNATIONAL_API], settleTimeout: Math.min(timeoutMs, 15_000),
      }, { provider: PROVIDER, timeoutMs, signal, maxBytes: 6_000_000, requireSolved: false, allowHttpStatuses: [404, 410] });
      signal.throwIfAborted();
      if (![2, 3].includes(page.tier) || page.url !== url) throw new TransportError(PROVIDER, 'Jumppoint International left its guest tracker');
      if ([404, 410].includes(page.statusCode)) throw new TransportError(PROVIDER, 'Jumppoint International tracking is unavailable', { status: page.statusCode });
      const captures = page.capturedResponses.filter(row => boundCapture(row.url, number) && row.status !== 204);
      if (!captures.length) {
        if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
        if (page.statusCode >= 500) throw new UpstreamHttpError(PROVIDER, page.statusCode);
        throw new ChallengeError(PROVIDER, 'Jumppoint International did not capture a whole-number tracking reply');
      }
      if (captures.length > 20) throw new SchemaError(PROVIDER, 'Jumppoint International returned too many replies');
      const reply = captures[captures.length - 1]!;
      if (reply.status === 429) {
        throw new RateLimitedError(PROVIDER, retryAfterMs(reply.headers['retry-after'], { dates: false }));
      }
      if ([401, 403].includes(reply.status)) throw new ChallengeError(PROVIDER, 'Jumppoint International refused tracking', { status: reply.status });
      if (reply.status >= 500) throw new UpstreamHttpError(PROVIDER, reply.status);
      if (reply.status !== 200) throw new TransportError(PROVIDER, 'Jumppoint International tracking is unavailable', { status: reply.status });
      if (reply.error || reply.truncated || reply.base64Encoded || typeof reply.body !== 'string') throw new TransportError(PROVIDER, 'Jumppoint International returned an incomplete reply');
      if (new TextEncoder().encode(reply.body).length > 1_000_000) throw new SchemaError(PROVIDER, 'Jumppoint International returned an oversized reply');
      let payload: unknown;
      try { payload = JSON.parse(reply.body); } catch { throw new SchemaError(PROVIDER, 'Jumppoint International returned invalid tracking JSON'); }
      return parseJumppointInternational(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new JumppointInternationalTracker({ trawl: environment.trawl, recorder: environment.recorder });
  return { id: 'jumppoint-international', steps: ['trawl'], recordsSteps: true,
    track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => accepted(() => normalizeJumppointInternationalNumber(number))
      ? recognizeFromBrowserLookup(() => tracker.fetch(number, context)) : Promise.resolve({ known: false, lastActivityAt: null }) };
};
