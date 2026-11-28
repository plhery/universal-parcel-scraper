/**
 * The Neoman GInfo tracking server, `GInfo.dll` on IIS, which HGD, SRJ, Yi Long Express, King
 * Delivery, Valueway Express, Qinhang Transportation, Ronghui Supply Chain and ESOWAY each run on a
 * host of their own, all but King Delivery and Valueway over plain HTTP.
 * Their sites' tracking forms post to the server's `EmmisTrack` page; the adapters read
 * `EmsApiTrack`, the record that page renders. Each carrier keeps its host, number shape and status
 * map; this module holds the request and the parser they share.
 */
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, textFromHtml, userAgentOf } from '../../core/transport/index.js';
import { itdidaCountry } from '../whwdt/itdida.js';

/** A row's wording, and the place and code a tenant writes into the same text. */
export interface GinfoRowText {
  readonly description: string;
  readonly location?: string;
  readonly code?: string;
}

/** The zone a row's wall clock is on, and how it was chosen, as `time_zone_basis` says it. */
export interface GinfoRowZone {
  readonly zone: string;
  readonly basis: 'place' | 'destination' | 'carrier';
}

/** The carrier that delivers a parcel and its number there. */
export type GinfoOnward = Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'>;

/** One carrier's tenant of the server. */
export interface GinfoTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The server's `GInfo.dll`. */
  readonly api: string;
  /** The site whose tracking form opens the server's page, sent as the Referer. */
  readonly site: string;
  /** The carrier's waybill without spaces or hyphens; anything else throws an InvalidInputError. */
  readonly normalize: (raw: string) => string;
  /** A row's stage, by its wording and the code `row` read from it ('' without one), or null. */
  readonly stage: (wording: string, code: string) => ClassifiedWording | null;
  /** The carrier's map, which tells a scan that moves nothing from one that moves the parcel. */
  readonly statusMap: CarrierStatusMap;
  /**
   * A row's wording, place and code, from its `INFO` and its `PLACE` as written, for a tenant that writes
   * them all in `INFO` or labels a row in `PLACE`. Without it, `INFO` is the wording.
   */
  readonly row?: (info: string, place: string) => GinfoRowText;
  /** The place a row's `PLACE` names, given its `INFO`, or '' when it holds something else. Without it, `PLACE` as written. */
  readonly place?: (place: string, info: string) => string;
  /**
   * The zone of a row's wall clock, from its `PLACE` and `INFO` as written, for a tenant whose rows
   * mix the clocks of several networks. Its rows are then dated on that zone and listed by their
   * instants. Without it, or for a row it gives none, a row keeps its wall clock alone.
   */
  readonly zone?: (place: string, info: string) => GinfoRowZone | null;
  /**
   * The catalog carrier each service `TRANSKIND` can name, for a tenant whose record gives that
   * carrier's number in `TRANS_NBR`. Without it, only `REFER_NBR` can name a delivery carrier.
   */
  readonly transfers?: Readonly<Record<string, string>>;
  /**
   * The delivery carrier and its number, from `REFER_NBR` and the scans, for a tenant whose rows
   * name the carrier it hands parcels to. Without it, a number in `REFER_NBR` that another carrier's
   * rules claim at high confidence.
   */
  readonly onward?: (reference: string, events: readonly CarrierEvent[], number: string) => GinfoOnward;
  /**
   * The tenant's page was seen to show `STATE` 3 as delivered (送达！) with `ADATE` as the delivery
   * time: the record then reads as delivered whatever its rows say.
   */
  readonly deliveredState?: true;
  /** The encoding the tenant's server answers in, for one that does not answer in UTF-8. */
  readonly encoding?: string;
}

// One parcel's record is a kilobyte or two.
export const GINFO_MAX_BYTES = 256 * 1024;
export const GINFO_REDIRECTS = [301, 302, 303, 307, 308];
// The clock the forwarders write their own rows on.
const ZONE = 'Asia/Shanghai';
// The record's first line: 100 for a waybill found, -102 for a number the tracker holds nothing under.
const FOUND = '100';
const UNKNOWN = '-102';
const DELIVERED_STATE = '3';
const RETURN = /^\s*(-?\d{1,5})\s*(?:\r?\n|$)/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// A day, with its time to the minute or the second when the row gives one.
const CLOCK = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2})(?::(\d{2}))?)?$/;
const ROW = /<DATETIME>([^<]*)<\/DATETIME>\s*<PLACE>([^<]*)<\/PLACE>\s*<INFO>([^<]*)<\/INFO>/g;
const WEIGHT = /^\d{1,4}(?:\.\d{1,3})?$/;
// A number standing whole in `REFER_NBR`, as opposed to a note.
const REFERENCE = /^[A-Z0-9]{8,40}$/;
const MAX_ROWS = 500;

/** The record the server gives for one number. */
export function ginfoLookupUrl(api: string, number: string): string {
  return `${api}?${new URLSearchParams({ MfcISAPICommand: 'EmsApiTrack', cno: number })}`;
}

/** The one element of a tag in a block, or nothing; a repeated one is a changed reply. */
function field(provider: string, block: string, tag: string, maxLength = 120): string {
  const matches = [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))];
  if (matches.length > 1) throw new SchemaError(provider, `${provider} returned a repeated ${tag}`);
  return matches.length ? textFromHtml(matches[0]![1], maxLength) : '';
}

/** The one block a tag encloses; none, or several, is a changed reply. */
function block(provider: string, body: string, tag: string): string {
  const matches = [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
  if (matches.length !== 1) throw new SchemaError(provider, `${provider} returned a record without one ${tag}`);
  return matches[0]![1]!;
}

/** A row's wall clock, to the minute or the second as the row gives it, or its day alone. */
function wallClock(provider: string, value: string): string {
  const match = CLOCK.exec(value);
  const time = match?.[2] ? `T${match[2]}${match[3] ? `:${match[3]}` : ''}` : '';
  const local = match ? `${match[1]}${time}` : '';
  const format = !match?.[2] ? 'yyyy-MM-dd' : match[3] ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm";
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat(format) !== local) {
    throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  }
  return local;
}

/**
 * A parcel's scans, newest first. The tracker lists them in the order they
 * were written, each a wall clock without its zone, some a day alone. A row
 * dated after the lookup on the forwarder's clock is not a scan yet and is
 * left out. A row without wording says nothing, and a repeated one is read
 * once. A row without clock, place or wording is a blank line some tenants
 * open their rows with. A tenant that names a row's zone has the row dated
 * on it, unless that dates it after the lookup.
 */
function scans(tenant: GinfoTenant, rows: string, readAt: number): CarrierEvent[] {
  const { provider } = tenant;
  const seen = new Set<string>();
  // Rows sort by their wall clocks, or by their instants for a tenant that names their zones.
  const read: { order: string | number; event: CarrierEvent }[] = [];
  const matches = [...rows.matchAll(ROW)];
  // Rows the pattern did not read are a changed reply.
  if (rows.replace(ROW, '').trim()) throw new SchemaError(provider, `${provider} returned an invalid scan`);
  if (matches.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  for (const [, clock, place, info] of matches) {
    if (![clock, place, info].some((part) => textFromHtml(part, 40))) continue;
    const local = wallClock(provider, textFromHtml(clock, 40));
    if (firstOccurrence(DateTime.fromISO(local, { zone: ZONE })).toMillis() > readAt) continue;
    const written = textFromHtml(place, 120);
    const text = tenant.row ? tenant.row(textFromHtml(info, 1000), written) : { description: textFromHtml(info, 300) };
    const description = clean(text.description, 300);
    if (!description) continue;
    const location = (written && tenant.place ? clean(tenant.place(written, textFromHtml(info, 1000)), 120) : written)
      || clean(text.location, 120);
    const code = text.code ?? '';
    const key = JSON.stringify([local, location, description, code]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = tenant.stage(description, code);
    const zone = tenant.zone?.(written, textFromHtml(info, 1000)) ?? null;
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: zone?.zone ?? ZONE }));
    const time = zone && local.includes('T') && instant.toMillis() <= readAt + CLOCK_SKEW_MS
      ? instant.toISO({ suppressMilliseconds: true }) : null;
    read.push({ order: tenant.zone ? instant.toMillis() : local, event: {
      ...(zone && time ? { time, time_zone: zone.zone, time_zone_basis: zone.basis } : {}),
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!read.length) throw new NoHistoryError(provider);
  // Newest first: the tracker's order reversed, then by clock, which keeps equal clocks in that order. A row
  // dated by its day alone comes after that day's timed rows.
  return read.reverse().sort((left, right) => (left.order < right.order ? 1 : left.order > right.order ? -1 : 0)).map((scan) => scan.event);
}

/**
 * The delivering carrier's number in `REFER_NBR`, when it is a whole number
 * another carrier's own rules claim at high confidence. HGD's records repeat
 * the waybill there, SRJ's give USPS's package number, Yi Long's a note.
 */
function handoff(tenant: GinfoTenant, reference: string, number: string): GinfoOnward {
  const onward = reference.toUpperCase();
  if (!REFERENCE.test(onward) || onward === number) return {};
  const match = detectCarrierMatch(onward);
  return match.confidence === 'high' && match.carrier !== 'unknown' && match.carrier !== tenant.carrier
    ? { delivery_carrier: match.carrier, delivery_tracking_number: onward } : {};
}

/**
 * The carrier a tenant's `TRANSKIND` names and its number in `TRANS_NBR`, when that
 * carrier's own rules claim the whole number at high confidence: King Delivery's
 * records name JD Logistics and its waybill there. Undefined otherwise.
 */
function transfer(tenant: GinfoTenant, info: string, number: string): GinfoOnward | undefined {
  const kind = field(tenant.provider, info, 'TRANSKIND', 60);
  const carrier = tenant.transfers && Object.hasOwn(tenant.transfers, kind) ? tenant.transfers[kind] : undefined;
  if (!carrier) return undefined;
  const onward = normalizeTrackingNumber(field(tenant.provider, info, 'TRANS_NBR', 64));
  const match = REFERENCE.test(onward) && onward !== number ? detectCarrierMatch(onward) : undefined;
  return match?.confidence === 'high' && match.carrier === carrier
    ? { delivery_carrier: carrier, delivery_tracking_number: onward } : undefined;
}

/**
 * The record a tenant's server returns for one number: a return code on the
 * first line, then the waybill's summary in `EMS_INFO` and its rows in
 * `TRACK_DATA`. `-102` is the answer for a number the tracker holds nothing
 * under. The waybill must be the whole number asked. The sender's address and
 * the forwarder's inner number are never kept.
 */
export function parseGinfo(tenant: GinfoTenant, body: string, raw: string, readAt = Date.now()): CarrierResult {
  const { provider } = tenant;
  const number = tenant.normalize(raw);
  const code = RETURN.exec(body)?.[1];
  if (!code) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`);
    throw new SchemaError(provider, `${provider} returned an invalid reply`);
  }
  if (code === UNKNOWN) throw new NotFoundError(provider, `${provider} has no parcel under this number`);
  if (code !== FOUND) throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  const info = block(provider, body, 'EMS_INFO');
  if (normalizeTrackingNumber(field(provider, info, 'TRCKING_NBR', 64)) !== number) {
    throw new SchemaError(provider, `${provider} did not answer for the parcel asked`);
  }
  const events = scans(tenant, block(provider, body, 'TRACK_DATA'), readAt);
  const latest = events[0]!;
  const staged = leadingScan(events, tenant.statusMap);
  const scanned = staged?.stage as Stage | undefined;
  const summary: Stage | undefined = tenant.deliveredState && field(provider, info, 'STATE', 8) === DELIVERED_STATE ? 'delivered' : undefined;
  const stage = summary ?? scanned;
  const source = summary && summary !== scanned ? 'carrier_map' : staged?.stage_source;
  const country = itdidaCountry(field(provider, info, 'DES', 60));
  const weight = field(provider, info, 'WEIGHT', 16);
  const kilograms = WEIGHT.test(weight) && Number(weight) > 0 ? Number(weight) : null;
  const reference = field(provider, info, 'REFER_NBR', 64);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(kilograms !== null ? { weight_kg: kilograms } : {}),
    ...(transfer(tenant, info, number)
      ?? (tenant.onward ? tenant.onward(reference, events, number) : handoff(tenant, reference, number))),
    events,
  };
}

export class GinfoTracker {
  constructor(private readonly tenant: GinfoTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const { tenant } = this;
    const number = tenant.normalize(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The number alone, with no session, token or account.
      const { response, bytes } = await fetchBounded(ginfoLookupUrl(tenant.api, number), { method: 'GET', signal, headers: {
        Accept: 'text/html, text/plain, */*', Referer: tenant.site, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: tenant.provider, fetcher: this.options.fetcher, maxBytes: GINFO_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...GINFO_REDIRECTS, 400, 404, 410] });
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(tenant.provider, `${tenant.provider} tracking lookup is unavailable`, { status: response.status });
      // The servers answer in UTF-8, unless the tenant names another encoding.
      return parseGinfo(tenant, decodeText(bytes, tenant.encoding), number);
    };
    // A request that fails to reach the server, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

/** A tenant's adapter: a lookup per number, and recognition by that lookup. */
export function ginfoAdapter(tenant: GinfoTenant): AdapterFactory {
  return (environment) => {
    const tracker = new GinfoTracker(tenant, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: tenant.carrier, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
      recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
        () => accepted(() => tenant.normalize(number))),
    };
  };
}
