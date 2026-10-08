import { DateTime } from 'luxon';
import type { Response as BrowserResponse } from 'playwright-core';
import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierIdsFromPartnerLinks } from '../../core/catalog/hints.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { explicitOffsetTime, EXPLICIT_OFFSET_PATTERN } from '../../core/time/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean, type TrawlClient, type TrawlScrapeResponse } from '../../core/transport/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { isRecord } from '../../core/types.js';
import { yunExpressCodeStatus, yunExpressStatus } from './status.js';

const API = 'https://services.yuntrack.com/Track/Query';
const MAX_BYTES = 1_000_000;

export function normalizeYunExpressNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^YT\d{16}$/.test(number)) throw new InvalidInputError('YunExpress', 'YunExpress requires a YT parcel reference');
  return number;
}

export function yunExpressTrackingUrl(raw: string): string {
  return `https://www.yuntrack.com/parcelTracking?id=${normalizeYunExpressNumber(raw)}`;
}

function eventClock(raw: string, offset?: string): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  if (EXPLICIT_OFFSET_PATTERN.test(raw)) {
    const parsed = explicitOffsetTime(raw);
    if (!parsed) throw new SchemaError('YunExpress', 'YunExpress returned an invalid scan time');
    return { time: parsed.iso };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) throw new SchemaError('YunExpress', 'YunExpress returned an invalid scan time');
  const parsed = DateTime.fromISO(`${raw}${offset ?? ''}`, { setZone: true, zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError('YunExpress', 'YunExpress returned an invalid scan time');
  const iso = parsed.toISO({ suppressMilliseconds: true, includeOffset: Boolean(offset) });
  return offset ? { time: iso } : { local_time: iso };
}

/**
 * The last-mile carrier whose official site the notes link to. The catalog
 * knows the host, and that carrier's own detection must offer the declared
 * reference: a brand's host can serve regional networks outside its scope.
 */
function linkedPartner(notes: unknown, reference: string): string | undefined {
  if (typeof notes !== 'string' || notes.length > MAX_BYTES) return undefined;
  const [partner, ...others] = carrierIdsFromPartnerLinks([notes], 'yunexpress');
  if (!partner || others.length) return undefined;
  return (detectCarrierMatch(reference).candidates as string[]).includes(partner) ? partner : undefined;
}

export function parse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeYunExpressNumber(trackingNumber);
  if (isRecord(payload) && [1003, 1004].includes(Number(payload.Code))) throw new ChallengeError('YunExpress', 'YunExpress requires its interactive tracking verification');
  if (!isRecord(payload) || !Array.isArray(payload.ResultList)) throw new SchemaError('YunExpress');
  const matches = payload.ResultList.filter((item) => isRecord(item) && item.Id === number);
  if (matches.length !== 1 || !isRecord(matches[0])) throw new SchemaError('YunExpress', 'YunExpress returned a different or ambiguous shipment');
  const item = matches[0];
  if (!isRecord(item.TrackInfo) || item.TrackInfo.WaybillNumber !== number || !isRecord(item.TrackData)) throw new SchemaError('YunExpress', 'YunExpress returned inconsistent parcel identity');
  const info = item.TrackInfo;
  const groups = item.TrackData.ProcessGroupList;
  if (!Array.isArray(groups)) throw new SchemaError('YunExpress');
  if (item.Status === 0 && info.TrackingStatus === 0 && groups.length === 0
    && info.TrackEventCount === 0 && item.TrackData.ChildCount === 0
    && Array.isArray(info.TrackEventDetails) && info.TrackEventDetails.length === 0
    && isRecord(info.LastTrackEvent) && info.LastTrackEvent.TrackingStatus === 0
    && info.LastTrackEvent.ProcessDate === '' && info.LastTrackEvent.ProcessContent === ''
    && info.LastTrackEvent.ProcessLocation === '') throw new NotFoundError('YunExpress');
  if (!groups.length) throw new IndeterminateError('YunExpress', 'YunExpress returned no parcel scans');
  if (groups.length > 500) throw new SchemaError('YunExpress');
  const last = isRecord(info.LastTrackEvent) ? info.LastTrackEvent : {};
  const lastOffset = /^GMT([+-]\d{2}:\d{2})$/.exec(clean(last.GmtProcessTimezone, 32))?.[1];
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let scans = 0;
  let current: ClassifiedStatus | undefined;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.ProcessDetailList) || !group.ProcessDetailList.length) throw new SchemaError('YunExpress');
    for (const raw of group.ProcessDetailList) {
      if (!isRecord(raw) || typeof raw.ProcessContent !== 'string' || ++scans > 500) throw new SchemaError('YunExpress');
      const content = clean(raw.ProcessContent, MAX_BYTES);
      const divider = content.lastIndexOf('----');
      const fullDescription = clean(divider < 0 ? content : content.slice(0, divider), MAX_BYTES);
      const fullLocation = divider < 0 ? '' : clean(content.slice(divider + 4), MAX_BYTES);
      const description = clean(fullDescription, 500);
      const location = clean(fullLocation, 200);
      // The portal can list an older row with a place but no wording. It names
      // no status, so it is skipped; the newest row must still say something.
      if (!description && events.length) continue;
      if (!description) throw new SchemaError('YunExpress', 'YunExpress returned an empty scan');
      const rawTime = clean(raw.ProcessDate, 64);
      // Only the separately described latest scan supplies a verified offset.
      // Storage/creation timezone fields say nothing about earlier scan clocks.
      const exactLast = rawTime === last.ProcessDate && fullDescription === clean(last.ProcessContent, MAX_BYTES)
        && fullLocation === clean(last.ProcessLocation, MAX_BYTES);
      const clock = eventClock(rawTime, exactLast ? lastOffset : undefined);
      if (events.length === 0 && !exactLast) throw new IndeterminateError('YunExpress', 'YunExpress latest summary does not match its first scan');
      const key = JSON.stringify([clock, description, location]);
      if (seen.has(key)) continue;
      seen.add(key);
      const classified = yunExpressStatus(description, exactLast ? last.TrackingStatus : undefined);
      if (events.length === 0) current = classified;
      events.push({ ...clock, description, location, ...(classified ? { stage: classified.stage } : {}) });
    }
  }
  if (!events.length) throw new IndeterminateError('YunExpress');
  if (Array.isArray(info.TrackEventDetails) && info.TrackEventDetails.length > scans) {
    throw new IndeterminateError('YunExpress', 'YunExpress returned incomplete parcel history');
  }
  const latest = events[0]!;
  const classified = current;
  const deliveryNumber = clean(info.TrackingNumber, 64).toUpperCase();
  const handoff = deliveryNumber !== number && /^[A-Z0-9]{4,40}$/.test(deliveryNumber) ? deliveryNumber : '';
  const partner = handoff ? linkedPartner(info.AdditionalNotes, handoff) : undefined;
  const country = clean(info.DestinationCountryCode, 8).toUpperCase();
  // The first event is the exact latest event, so its code belongs to it.
  return { status: classified?.status ?? yunExpressCodeStatus(last.TrackingStatus) ?? 'unknown', ...(classified ? { current_stage: classified.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(classified?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(handoff ? { delivery_tracking_number: handoff, ...(partner ? { delivery_carrier: partner } : {}) } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}), events: events.slice(0, 100) };
}

/** A later captured reply is final; never silently reuse an earlier success. */
export function parseCaptured(page: TrawlScrapeResponse, number: string): CarrierResult {
  const capture = page.capturedResponses.filter((entry) => entry.url === API).at(-1);
  if (!capture) throw new TransportError('YunExpress', 'The browser service did not capture YunExpress history');
  if (capture.status >= 400) {
    if ([401, 403, 405].includes(capture.status)) throw new ChallengeError('YunExpress', 'YunExpress rejected the browser tracking request', { status: capture.status });
    throw new UpstreamHttpError('YunExpress', capture.status);
  }
  if (capture.status !== 200 || capture.truncated || capture.error || capture.body === null || capture.body.length > MAX_BYTES) throw new IndeterminateError('YunExpress', 'The browser returned incomplete YunExpress history');
  const body = capture.base64Encoded ? Buffer.from(capture.body, 'base64').toString('utf8') : capture.body;
  let payload: unknown;
  try { payload = JSON.parse(body); } catch (error) { throw new SchemaError('YunExpress', 'YunExpress returned unreadable tracking JSON', { cause: error }); }
  return parse(payload, number);
}

function localBrowser(number: string, executablePath: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
  return withLocalBrowser({ provider: 'YunExpress', executablePath, signal, timeoutMs }, async ({ browser, signal: session, remainingMs }) => {
    let rejectHistory!: (error: unknown) => void;
    let resolveHistory!: (result: CarrierResult) => void;
    let settled = false;
    const history = new Promise<CarrierResult>((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject; });
    void history.catch(() => {});
    const fail = (error: unknown) => { if (!settled) { settled = true; rejectHistory(error); } };
    // A reply that arrives after the lookup ended is never history.
    session.addEventListener('abort', () => { settled = true; }, { once: true });
    const page = await browser.newPage({ locale: 'en-US' });
    // Request interception makes the same fresh session receive API 405.
    // Observe response events without altering the browser's network requests.
    page.on('response', async (response: BrowserResponse) => {
      if (settled || response.url() !== API || response.request().method() !== 'POST') return;
      try {
        const body = response.request().postDataJSON() as unknown;
        if (!isRecord(body) || !Array.isArray(body.NumberList) || body.NumberList.length !== 1 || body.NumberList[0] !== number) throw new SchemaError('YunExpress', 'The browser submitted a different parcel');
        if (response.status() !== 200) {
          if ([401, 403, 405].includes(response.status())) throw new ChallengeError('YunExpress', 'YunExpress rejected the browser tracking request', { status: response.status() });
          throw new UpstreamHttpError('YunExpress', response.status());
        }
        if (Number(response.headers()['content-length']) > MAX_BYTES) throw new SchemaError('YunExpress', 'YunExpress returned excessive tracking data');
        const bytes = await response.body();
        if (bytes.length > MAX_BYTES) throw new SchemaError('YunExpress', 'YunExpress returned excessive tracking data');
        const result = parse(JSON.parse(bytes.toString('utf8')) as unknown, number);
        if (!settled) { settled = true; resolveHistory(result); }
      } catch (error) { fail(error instanceof SyntaxError ? new SchemaError('YunExpress', 'YunExpress returned unreadable tracking JSON', { cause: error }) : error); }
    });
    const navigation = page.goto(yunExpressTrackingUrl(number), { waitUntil: 'domcontentloaded', timeout: remainingMs() }).then((response) => {
      if (!response || response.status() !== 200) throw new TransportError('YunExpress', 'YunExpress tracking page is unavailable');
      return history;
    });
    void navigation.catch(() => {});
    return await Promise.race([navigation, history]);
  });
}

export class YunExpressTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; executablePath?: string | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeYunExpressNumber(raw);
    const budgetMs = context.budgetMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('YunExpress timeout must be positive');
    if (!this.options.trawl && !this.options.executablePath) throw new ChallengeError('YunExpress', 'YunExpress requires a configured tracking browser');
    return runSteps({ carrier: 'yunexpress', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      // The shared launcher serves a lookup for at most 60 s; a longer budget gives the browser that much.
      { id: 'browser', enabled: Boolean(this.options.executablePath), run: ({ signal, remainingMs }) => localBrowser(number, this.options.executablePath!, signal, Math.min(60_000, Math.max(1, Math.floor(remainingMs)))) },
      // Keep the local runtime primary. Service capture needs the matching
      // decoded-response hook and is used only without local Chromium.
      { id: 'trawl', enabled: !this.options.executablePath && Boolean(this.options.trawl), run: async ({ signal, remainingMs }) => {
        const timeoutMs = Math.max(1, Math.min(25_000, Math.floor(remainingMs)));
        const page = await this.options.trawl!.scrape({ url: yunExpressTrackingUrl(number), skipHttp: true, maxTier: 2,
          maxTimeout: timeoutMs, captureResponses: [API], settleTimeout: 5_000 }, {
          provider: 'TRAWL while fetching YunExpress', timeoutMs, maxBytes: 2_000_000, fetcher: this.options.fetcher, signal });
        return parseCaptured(page, number);
      } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment: AdapterEnvironment) => {
  const tracker = new YunExpressTracker({ trawl: environment.trawl, executablePath: environment.browserExecutablePath,
    fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'yunexpress', recordsSteps: true, steps: ['browser', 'trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
