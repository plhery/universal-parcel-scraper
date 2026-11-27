
/**
 * ParcelsApp (parcelsapp.com), a universal aggregator used as the second
 * discovery provider.
 *
 * Transport: a scoped anonymous POST reproduces the public frontend checksum
 * and submits the stored delivery postcode. Browser capture remains recovery
 * for protocol challenges. Numberless direct replies belong to their single
 * POST; captured replies still require the rendered result's identity.
 */
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import timers from 'node:timers/promises';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { carrierDefinition, carrierTimezone } from '../../core/catalog/index.js';
import {
  brandCarrierIds, brandTimeZones, carrierBrand, carrierIdFromName, carrierNameCountryZone, isCarrierFeedName, isKnownCarrierName,
} from '../../core/catalog/hints.js';
import { GROUP_LOOKUP_BRANDS } from '../../core/catalog/networks.js';
import { detectCarrierMatch, isValidS10TrackingNumber } from '../../core/detection/index.js';
import { CarrierError, carrierErrorKind, ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { paddedDate } from '../../core/time/fields.js';
import {
  canadaProvinceTimeZone, countryCode, countryTimeZone, mislabeledLocalTime, mislabeledWallTime, regionHasTown, sharedClockZone,
  timeZoneCountry, usStateTimeZone, usZipState,
} from '../../core/time/index.js';
import type { TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { carrierHomeZone } from '../../places/clocks.js';
import { airportTimeZone, locatePlace, placeTimeZone, splitRegionTownZone } from '../../places/index.js';
import { countryName, militaryPostOffice } from '../../places/trackingLocation.js';
import { countryZones, hasSeveralClocks, keepsZone, mainZone } from '../../places/zones.js';
import { captureFailure, capturedBodies, loadCapture, type CaptureSpec } from '../shared/capture.js';
import { CAINIAO_CHINA_LEG, CAINIAO_CHINA_ZONE } from '../../carriers/aliexpress/clock.js';
import { POSTNL_ACCEPTANCE_STAMP, POSTNL_CUSTOMS_STAMP, POSTNL_UTC_RECORD } from '../../carriers/spring-gds/clock.js';
import { OMNIPARCEL_DEFAULT_CLOCK, OMNIPARCEL_NUMBER } from '../../carriers/seko/clock.js';
import { muserTown, muserTrailingPlace } from '../../carriers/muser/parser.js';
import { chinaPostEnglish, chinaPostLabelPlace } from '../../carriers/china-post/status.js';
import { correosDeMexicoForeignClock } from '../../carriers/correos-de-mexico/clock.js';
import { correosOriginZone } from '../../carriers/correos-spain/clock.js';
import { cttSiteZone, portugalZone } from '../../carriers/ctt/clock.js';
import { DHLINK_RECORD_ZONE, usClockCopy } from '../../carriers/dhlink/clock.js';
import { EMIRATES_POST_ZONE, UAE_PLACE } from '../../carriers/emirates-post/clock.js';
import { epostGlobalCopyZone } from '../../carriers/epost-global/status.js';
import { FIRST_LINE_CHINA_ZONE, firstLineInChina } from '../../carriers/first-line/clock.js';
import { juxiExpressAbroadZone } from '../../carriers/juxi-express/clock.js';
import { sxwAbroadZone } from '../../carriers/sxw-express/parser.js';
import { HAYPOST_ZONE, haypostEdiReceived } from '../../carriers/haypost/clock.js';
import { hrvatskaPostaForeignZone } from '../../carriers/hrvatska-posta/parser.js';
import { imileCountryClock } from '../../carriers/imile/clock.js';
import { jsExpressChinaClock } from '../../carriers/js-express/clock.js';
import { pitneyBowesPlatformClock, pitneyBowesPostalRelay } from '../../carriers/pitney-bowes/clock.js';
import { pocztaPolskaPartnerClock } from '../../carriers/poczta-polska/clock.js';
import { destinationRelay, europeanAbroad, royalMailPartnerCountry, royalMailPartnerWall, royalMailRelayClock } from '../../carriers/royal-mail/clock.js';
import { USPS_FACILITY_KIND, uspsScanZone } from '../../carriers/usps/clock.js';
import { YUNEXPRESS_IMPORT_CUSTOMS, yunExpressOriginLeg } from '../../carriers/yunexpress/clock.js';
import { facilityZone, LatestScan, relaysFacilityClock } from '../shared/facilityClock.js';
import { CHINESE_CITIES, CHINESE_PROVINCES } from '../shared/china.js';
import { brandCarrierForNumber, universalCarrierHints } from '../shared/hints.js';
import { copyWording, event, eventStage, foreignEvent, isNotice, localEvent, numberOf, place as reportedPlace, result, type UniversalSource } from '../shared/result.js';
import { carrierScan, dropStepNotices, markLaterReceipts, markReturnLeg, type CarrierScan } from '../shared/scans.js';
import { PARCELSAPP_API, ParcelsAppHttpClient } from './http.js';

const SOURCE: UniversalSource = 'ParcelsApp';
const MAX_EVENTS = 1000;
export const PARCELSAPP_BUDGET_MS = 45_000;
const DIRECT_BUDGET_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
// How long before every other scan a 1 January 00:00 must lie to be a placeholder.
const PLACEHOLDER_LEAD_DAYS = 60;

// ParcelsApp's response omits the number. Bind it to the rendered result's
// tracking-number row, never merely to the input field or the requested URL.
function parcelsIdentity(html: string, number: string): boolean {
  const $ = load(html);
  const rows = $('.tracking-info .parcel .parcel-attributes tr').filter((_, row) =>
    $(row).children('td').first().text().trim() === 'Tracking number');
  return rows.length === 1 && rows.first().children('td').eq(1).text().trim() === number;
}

/** ParcelsApp's results without a shipment: its empty view, with no shipment's rows. */
function emptyView(html: string): boolean {
  const $ = load(html);
  return $('.tracking-info.empty').length === 1 && !$('.tracking-info .parcel .parcel-attributes tr').length;
}

export function parseParcelsAppResponse(payload: unknown, trackingNumber: string, html: string, timezone: string | null = null,
  readAt = Date.now()): CarrierResult {
  return parseResponse(payload, trackingNumber, html, timezone, readAt, null);
}

/** A reply the page captured, for a parcel filed under a carrier (`filedNetworkZone`) or none. */
function parseResponse(payload: unknown, trackingNumber: string, html: string, timezone: string | null, readAt: number,
  filed: string | null): CarrierResult {
  if (!parcelsIdentity(html, numberOf(trackingNumber))) throw new SchemaError(SOURCE, 'ParcelsApp shipment identity missing');
  return parseHistory(payload, trackingNumber, timezone, readAt, filed);
}

/**
 * ParcelsApp's `date` is the scan's local clock, labeled as UTC or shifted
 * into an offset of its own: a DPD scan at 14:05+02:00 arrives as
 * "14:05+00:00", a Swiss Post delivery at 11:30 local as "13:30+02:00"
 * (both shapes checked 2026-09-22). Its UTC digits are re-read in the zone
 * of the scan's carrier, else its location's country, else the country the
 * carrier name ends with ("DPD UK"), else, for a scan with no location, the
 * clock that all catalog networks of a bare brand share at that moment
 * ("GLS"), or that the network which labelled the parcel shares with its
 * destination ("DPD Group", `brandNetworkZones`), else the zone routing passes
 * for the parcel. Without one it stays as labeled, as it does when the name's
 * country or the parcel's zone meets a location in another country, unless
 * nothing knows its network (`unknownNetwork`), it is a bare brand whose
 * networks all keep local clocks (`localClockBrand`) or it is at a US
 * military post office: it then keeps its wall clock. TNT's
 * international scans stay as labeled too: tnt.com gives them offsets, and
 * ParcelsApp's UTC matches them. So do Asendia USA's, wherever they happened:
 * their dates are the UTC instants of Asendia's A1 feed, and Swiss Post's own
 * scans of the same item agree (checked 2026-09-30). So do Paack's: its
 * timeline gives instants, and Paack's own lookup has ParcelsApp's UTC scan
 * for scan (checked 2026-10-07). So do Vinted Go's: its own instants, in the
 * Netherlands and Spain, have ParcelsApp's UTC digits to the second. So do
 * Austrian Post's: its own instants have ParcelsApp's UTC digits to the second
 * (checked 2026-10-16), while the EURODIS copies of the same scans carry the
 * wall clock. So do Straightship's: its page writes every clock in UTC, and
 * its own rows have ParcelsApp's UTC digits to the second; read on its
 * Vancouver clock they came out seven hours late (checked 2026-10-19).
 */
function stateCarrierName(payload: Record<string, unknown>, state: Record<string, unknown>): unknown {
  const carriers = Array.isArray(payload.carriers) ? payload.carriers : [];
  return typeof state.carrier === 'number' ? carriers[state.carrier] : undefined;
}

// The names ParcelsApp gives Asendia USA's scans.
const ASENDIA_USA = /^asendia\s+(?:usa|united\s+states)$/i;
/** A carrier name as the tables below key it: "GoFo Express" is "gofoexpress". */
const nameKey = (name: unknown) => typeof name === 'string' ? name.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
// Carriers whose ParcelsApp dates are a North American scan's local clock:
// UPS's own instants, FedEx's own page, UniUni's own feed and Ship24's offsets
// agree once they are read that way (checked 2026-09-30 on US scans; UPS's
// also in Germany, the Netherlands and Spain). So does DHL eCommerce's
// Webtrack, which names each scan's clock, on all 25 scans of three parcels
// in seven states and the UK (2026-10-11). OnTrac's are UTC and Landmark's
// keep its home clock everywhere (HOME_CLOCKS), so no other carrier gets this
// step beyond the ones below.
const LOCAL_CLOCK_CARRIERS = new Set(['ups', 'fedex', 'uniuni', 'uniexpress', 'easyship', 'dhlecommerce']);
/**
 * Of those, the carriers whose scans with no location, or placed only in the
 * US or Canada, are on a local clock too, so that one nothing places is a wall
 * time, not the label's instant. Their own trackers date UPS's "Shipper
 * created a label" and FedEx's "Order Created" (at "US" alone in ParcelsApp's
 * copy) at the same digits, on a clock that is not always the pickup's
 * (Eastern time for a parcel picked up on Pacific time), and UPS's customs
 * scan at the clearing agency on the destination's: read as labeled, it came
 * 11 hours after UPS's own instant. UniUni's "UNI DATA CENTER" scans, by
 * contrast, have the UTC instants of UniUni's own feed.
 */
const UNLOCATED_LOCAL_CLOCKS = new Set(['ups', 'fedex']);
/**
 * The day of a step its carrier dates without a time, which ParcelsApp writes
 * at 00:00: FedEx's own feed sends its pickup ("Picked up", `PU`) with a date,
 * a 00:00:00 time and no offset, and every other scan with its offset.
 * ParcelsApp words it "Picked Up", with a no-break space. Read at midnight on
 * the pickup's clock, it took a time FedEx never gives; it keeps its day in
 * `local_time` instead. BRT's page gives its "FOR DELIVERY" step a date and
 * no time, and ParcelsApp writes it at 00:00 too. So does USPS's for its
 * pre-shipment notice and its place-less "In Transit to Next Facility" (worded
 * "In Transit, Arriving On Time" or "Arriving Late" while it is the newest):
 * read on the clock of a placed scan near it, it came at a US midnight. A
 * shipping partner's step filed under UPS or USPS ("Departed Shipping Partner
 * Facility, EXAMPLE CITY, CA 12345") can come at 00:00 too, while UPS's own
 * lookup gives the same step its minute that morning. A date ParcelsApp sends
 * with no time at all ("2026-10-16"), as on BRT parcels while BRT's own
 * tracker is down, keeps its day whatever the carrier.
 */
const USPS_UNTIMED = /^(?:in\s+transit(?:\s+to\s+next\s+facility|,\s*arriving\s+(?:on\s+time|late))|pre-shipment\s+info\s+sent\s+to\s+usps(?:,\s*usps\s+awaiting\s+item)?)$/i;
const SHIPPING_PARTNER_STEP = /\bshipping\s+partner\b/i;
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;
function datedOnly(name: unknown, status: string, date: unknown): string | null {
  const wall = mislabeledWallTime(date);
  if (wall && typeof date === 'string' && BARE_DAY.test(date.trim())) return wall.slice(0, 10);
  if (!wall || !/T00:00:00(?:\.0+)?$/.test(wall)) return null;
  const key = nameKey(name);
  const step = key === 'fedex' ? /^picked\s+up$/i : key === 'usps' ? USPS_UNTIMED
    : typeof name === 'string' && carrierIdFromName(name) === 'brt' ? /^for\s+delivery$/i : null;
  const partner = (key === 'ups' || key === 'usps') && SHIPPING_PARTNER_STEP.test(status);
  return step?.test(status.trim()) || partner ? wall.slice(0, 10) : null;
}

/**
 * The networks a reply dates by their day alone: at least three scans of
 * theirs over two days or more, none with an offset of its own, on a clock
 * nobody scanned at (`dayClock`). ParcelsApp writes every scan of Shiprocket's
 * at 00:00:00, while Shiprocket's own tracker gives each of them its minute
 * (2026-10-17), and CDEK's and SEUR's on one minute with seconds that count
 * the scans (07:00:00, 07:00:01...), while CDEK's own lookup has each scan's
 * instant. Four scans or more on one minute, each with seconds of its own,
 * are such a count too, whatever their order: ParcelsApp's copies of Pasarex's
 * Spanish steps, over a week at 00:59:51 to 00:59:59, listed by day. A network
 * with one scan at midnight keeps it. The rendered page prints no seconds
 * (`minutes`).
 */
function dayOnlyNetworks(entries: readonly { name: unknown; date: unknown; offset?: string | null }[], minutes = false): Set<string> {
  const walls = new Map<string, (string | null)[]>();
  const dials = new Set<string>();
  for (const { name, date, offset } of entries) {
    walls.set(nameKey(name), [...walls.get(nameKey(name)) ?? [], offset ? null : mislabeledWallTime(date)]);
    if (twelveHourDial(name)) dials.add(nameKey(name));
  }
  return new Set([...walls].filter(([key, list]) => STEP_COUNTED_NETWORKS.has(key)
    ? list.every((wall) => wall !== null && STEP_COUNT.test(wall))
    : dials.has(key) ? list.every((wall) => wall !== null)
      : list.length >= 3 && (dayClock(list, minutes) || countedClock(list)) && new Set(list.map((wall) => wall!.slice(0, 10))).size >= 2)
    .map(([key]) => key));
}

/** Four wall clocks or more on one minute, with whole seconds that all differ. */
function countedClock(walls: readonly (string | null)[]): boolean {
  const clocks = walls.map((wall) => wall ? /T(\d{2}:\d{2}):(\d{2})(?:\.0+)?$/.exec(wall) : null);
  return clocks.length >= 4 && clocks.every((clock) => clock && clock[1] === clocks[0]![1])
    && new Set(clocks.map((clock) => clock![2])).size === clocks.length;
}

/**
 * Carriers whose tracker prints a scan's clock on a twelve-hour dial without AM or PM, which
 * ParcelsApp copies as it is. Barid Al-Maghrib's ("Morocco Post") copies of the sending post's
 * scans have that post's digits on its own clock, folded: its copy of Australia Post's 22:21
 * clearance awaiting departure came at 10:21, read on Casablanca's clock half a day early. Their
 * scans keep their day, as the carrier's own adapter keeps them.
 */
const TWELVE_HOUR_DIALS = new Set(['barid-al-maghrib']);
function twelveHourDial(name: unknown): boolean {
  const carrier = typeof name === 'string' ? carrierIdFromName(name) : undefined;
  return carrier !== undefined && TWELVE_HOUR_DIALS.has(carrier);
}

/**
 * A twelve-hour dial's copy of another network's scan in the same reply: the sending post's scan,
 * which Morocco Post relays in its own words at that scan's minute (Barid Al-Maghrib's relayed labels). Australia Post's "Received by
 * our network" at 09:18:52 came as "Shipment picked up" at 09:18, and its 22:21:11 clearance
 * awaiting departure as "Package shipped" at 10:21. The dial keeps the scan's day, its minute and
 * its hour on a twelve-hour clock, and the copy the scan's stage; a relay at another hour, on
 * another day or of another stage (a pickup beside the sending post's registration) is a scan of its own.
 * The scan is compared on its own wall clock: its digits where a zone places them or nothing
 * reads them as an instant, else its instant at the offset it states or on its carrier's home
 * clock (bpost's 13:05 UTC is 2:05 on the dial in Brussels).
 * Read by its day alone, the copy would stand beside the scan, so it is not read. The copy names
 * the sending post's country, as the relays do; a row placed in Morocco or another country, or
 * in none, is a scan of its own, since no field then shows it is a copy.
 */
function twelveHourCopies<T extends { name: unknown; date: unknown; offset: string | null; location: string;
  nationwide: boolean; wallOnly: boolean; scan: CarrierScan | undefined; wording: string }>(entries: readonly T[], zones: readonly { zone: string | null }[]): Set<T> {
  const at = (date: unknown) => {
    const wall = mislabeledWallTime(date);
    const read = wall ? DateTime.fromISO(wall, { zone: 'utc' }) : null;
    return read?.isValid ? read : null;
  };
  const ownClock = (own: T, index: number) => {
    const digits = at(own.date);
    if (!digits || zones[index]?.zone || unplacedLocalClock(own) || own.wallOnly) return digits;
    if (own.offset) {
      const stated = DateTime.fromISO(String(own.date).trim(), { setZone: true });
      return stated.isValid ? stated : null;
    }
    const carrier = typeof own.name === 'string' ? carrierIdFromName(own.name) : undefined;
    const home = carrier ? carrierHomeZone(carrier) : null;
    return home ? digits.setZone(home) : digits;
  };
  return new Set(entries.filter((copy) => {
    const relayed = twelveHourDial(copy.name) ? copy.scan?.stage : undefined;
    const dial = relayed ? at(copy.date) : null;
    const country = dial ? locatePlace(copy.location)?.country : undefined;
    return dial !== null && country !== undefined && entries.some((own, index) => {
      if (twelveHourDial(own.name) || (own.scan?.stage ?? eventStage(own.wording)) !== relayed) return false;
      if (!sendingCountries(own).includes(country)) return false;
      const scan = ownClock(own, index);
      return scan !== null && scan.toISODate() === dial.toISODate() && scan.minute === dial.minute && scan.hour % 12 === dial.hour % 12;
    });
  }));
}

/** The countries a sending post's scan is in: its place's, else its carrier's. */
function sendingCountries(own: { name: unknown; location: string }): readonly string[] {
  const placed = locatePlace(own.location)?.country;
  if (placed) return [placed];
  const carrier = typeof own.name === 'string' ? carrierIdFromName(own.name) : undefined;
  return carrier ? carrierDefinition(carrier).countries ?? [] : [];
}

/**
 * Whether a scan no zone places keeps its wall clock rather than ParcelsApp's label: a facility
 * clock's, or a UPS or FedEx scan with no location or placed only in the US or Canada.
 */
function unplacedLocalClock(entry: { name: unknown; location: string; nationwide: boolean }): boolean {
  return relaysFacilityClock(entry.name) || ((!entry.location || entry.nationwide) && UNLOCATED_LOCAL_CLOCKS.has(nameKey(entry.name)));
}

/**
 * Networks whose steps ParcelsApp always dates by their day alone, at the top of an hour with
 * seconds that count the steps, however few the reply has: myBRT.it's progress bar ("Spedizione
 * consegnata a BRT" at 01:00:01, "In viaggio" at 01:00:02 the next day), steps BRT's own
 * tracker does not list. Read as instants, they came seconds after midnight.
 */
const STEP_COUNTED_NETWORKS = new Set(['mybrtit']);
const STEP_COUNT = /T\d{2}:00(?::0\d(?:\.0+)?)?$/;

/**
 * Whether a network's wall clocks, in the reply's order, stand for no time:
 * all at 00:00:00, or all on one minute with whole seconds that step by one
 * from scan to scan, up or down. Real scans to the minute vary their minutes,
 * and real seconds do not count scans across days; seconds that skip or carry
 * milliseconds keep their times. Without seconds, one minute for all is enough.
 */
function dayClock(walls: readonly (string | null)[], minutes: boolean): boolean {
  const clocks = walls.map((wall) => wall ? /T(\d{2}:\d{2}):(\d{2})(?:\.0+)?$/.exec(wall) : null);
  if (!clocks.every((clock) => clock && clock[1] === clocks[0]![1])) return false;
  const seconds = clocks.map((clock) => Number(clock![2]));
  const step = seconds[1]! - seconds[0]!;
  return minutes || (clocks[0]![1] === '00:00' && seconds.every((second) => second === 0))
    || (Math.abs(step) === 1 && seconds.every((second, index) => !index || second - seconds[index - 1]! === step));
}

/**
 * The day of a scan whose network the reply dates by its day alone
 * (`dayOnlyNetworks`): that of ParcelsApp's digits, the network's own clock,
 * as the midnight rule takes it. The UTC day of the instant they read as can
 * be another: a count from 00:00:01 on Madrid's winter time is 23:00:01 UTC
 * the day before.
 */
function networkDay(networks: ReadonlySet<string>, name: unknown, date: unknown): string | null {
  return networks.has(nameKey(name)) ? mislabeledWallTime(date)?.slice(0, 10) ?? null : null;
}

/** A step dated by its day alone. */
function dayEvent(day: string, description: string): CarrierEvent | null {
  const parsed = localEvent(`${day}T00:00:00`, description);
  return parsed && { ...parsed, local_time: day };
}

/**
 * Carriers whose dates are each scan's local clock under a label that is
 * never its instant, checked scan for scan on 2026-10-10: USPS's own page,
 * and the "at 8:25 am" ParcelsApp relays in its text; Canada Post's digits;
 * GOFO's US feed, which gives the offsets; Orange Connex's times and offsets
 * for SpeedPAK; the EMS office clocks Parcelforce and NZ Post relay; Cainiao's
 * leg by leg, on GMT+8, +2 or +1, also under EcoScooting; 4PX's and
 * MailAmericas' (below). They are read in the state, province or single-clock
 * country their location names; `wallClockZones` reads the others.
 * Australia Post's are its tracker's digits, each scan's clock as Australia Post states it: a
 * clearance it dates 22:21:11 in Sydney came at 22:21:11 here, and ParcelsApp gave the same scan
 * its instant, 11:21:11, a few days before; its scans in Australia take the state or capital
 * their place names (`australiaPostZone`).
 * FIRST LINE's ("1ST") rows abroad are its delivery partner's scans on their
 * facility's clock: a copy of a GOFO scan in California came at GOFO's digits,
 * and read on Beijing's clock, its arrival in Los Angeles came twelve minutes
 * after the flight left Shenzhen. Its rows in China, and its order data with
 * no place, are Beijing's (`carrierClock`).
 */
const WALL_CLOCKS = new Set(['usps', 'canadapost', 'gofoexpress', 'speedpak', 'ems', 'cainiao', 'ecoscooting', '4pxexpress', 'mailamericas', '1st', 'australiapost']);
/**
 * A mailer's label that ParcelsApp files under USPS, its place repeated after
 * its wording ("Shipping Label Created, EXAMPLE CITY, CA 12345"), where USPS's
 * own rows read "Shipping Label Created, USPS Awaiting Item". Its date is the
 * instant: read on its place's clock, three labels came eight hours after
 * ParcelsApp first returned them, and Juxi Express's rows of this shape fall
 * between 17TRACK's instants of the same warehouse's steps as labeled. The
 * label as USPS words it ("Shipping Label Created", or after "USPS Awaiting
 * Item" with its place) keeps its place's clock, as USPS's adapter reads it
 * (`uspsRowZone`). A shipping partner's steps ("Arrived Shipping Partner Facility, EXAMPLE CITY,
 * NV 12345") and USPS's own scans can come with their place after them too, and
 * keep their place's clock, as USPS's own tracker dates them: ParcelsApp's
 * copies of a partner's pickup and arrival had the digits USPS dates on that
 * clock, and its departure, read as an instant, came before the arrival.
 */
const USPS_LABEL_ROW = /^shipping label created,[^,]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?$/i;
const uspsLabelRow = (name: unknown, status: string) => nameKey(name) === 'usps' && USPS_LABEL_ROW.test(status.trim());
/**
 * How far after the read a USPS scan that its place dates may come out. Later, it is held
 * back until a read catches up with it, as the USPS adapter holds USPS's planned
 * departures: ParcelsApp gives a scan it has just picked up its instant, and the place's
 * wall clock once it reads USPS again. Two scans it returned within three hours came
 * hours after the read on Georgia's clock, and a later read gave them Georgia's digits.
 */
const USPS_AHEAD_MS = 5 * 60 * 1_000;

/** Whether a USPS scan its place dates comes out more than `USPS_AHEAD_MS` after the read. */
const uspsAhead = (name: unknown, location: string, zone: string | null, event: CarrierEvent, readAt: number): boolean =>
  nameKey(name) === 'usps' && !!location && !!zone && typeof event.time === 'string' && Date.parse(event.time) > readAt + USPS_AHEAD_MS;
// Known clocks that are the destination or origin country's (`knownClock`).
const DESTINATION = 'destination';
// Destinations in the European Union, the European Economic Area, Switzerland and the UK.
const EUROPE: ReadonlySet<string> = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE',
  'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'IS', 'LI', 'NO', 'CH', 'GB']);
const ORIGIN = 'origin';
const wordings = (list: readonly string[]) => new RegExp(`^(?:${list.join('|')})$`, 'i');
// EMS's last-mile scans, which happen in the destination.
const EMS_LAST_MILE = wordings(['arriv(?:al|ed) at delivery office', 'out for delivery', 'unsuccessful delivery', 'delivered', 'final delivery']);
// Cainiao's last-mile scans, in its words or the local carrier's.
const CAINIAO_LAST_MILE = [
  'received by local\\s+delivery company', '(?:at|left) destination country/region(?: sorting center)?', 'arrived at local delivery center',
  'out for delivery', 'delivery failed(?:\\. not at home\\.)?', 'delivery attempt failure,.*', '(?:item )?delivered',
  'parcel is handled', 'your shipment has been delivered to the postal operator of the country.*',
  'first parcel scan along .+ logistic network', 'package arrived at facility of the local delivery company',
];
/**
 * The clocks of some wall-clock scans whatever their neighbours', from each
 * carrier's own offsets. GOFO's feed dates its labels on Pacific time
 * wherever the parcel is injected (a Florida parcel's at -07:00; 2026-10-10),
 * and GOFO Canada's on Toronto's, also for a parcel bound for British Columbia
 * (`to`: the parcel's destination); read on Pacific, a Canadian label came
 * three hours after the origin scan it followed by seconds.
 *
 * Cainiao's own feed (checked 2026-10-11 on parcels to the UK, Belgium,
 * Spain, Italy, Japan, Brazil and the US) dates its origin leg on China time
 * (`CAINIAO_CHINA_LEG`), from the warehouse to the departing linehaul, and the return warehouse
 * too, the warehouse's own steps and the origin sorting center's among them:
 * AliExpress's feed dates those +08:00, at sorting centers in mainland China
 * and Hong Kong. "Carrier update" is not listed: besides its own notices, on
 * China time, Cainiao words its transit sorting centers' scans that way. The seller's step before the warehouse is on China time as well:
 * read as labeled, it comes after ParcelsApp first returns it. It dates
 * import customs on the destination's clock, and the last mile as well,
 * except the UK's, on GMT in July. In a country of several clocks its import
 * customs is on the main one, Brasília's for Brazil and Mexico City's for
 * Mexico, but not in the US, where it is on the port of entry's: AliExpress's
 * feed stated a start -05:00 that ParcelsApp's UTC label put five hours early.
 * With no scan of its network placed in the destination to borrow from, such a
 * scan keeps its wall clock (`knownClock`). Its transit hub's arrival, warehouse
 * outbound and departure on a parcel to Europe are on Central European time:
 * AliExpress's feed states them +02:00 in summer and +01:00 in winter on
 * parcels to Switzerland, Spain, France and Italy, and ParcelsApp's copies
 * keep the digits. So is "Arrived at linehaul office" on a parcel to Europe,
 * also to the UK and Portugal, the European hub's arrival; elsewhere it is on
 * the destination's clock, as import customs is: a parcel to Colombia reached
 * that office four minutes before MailAmericas' "Delivered by Airline" there.
 * Its plain arrival in a transit country ("Arrive at transit country or
 * district"), which it also states on UTC, is not listed. A
 * parcel bound for Portugal clears customs in Spain, on Madrid's clock:
 * AliExpress's own "Departed from customs" and the Madrid broker's scans have
 * the digits of Cainiao's import customs. The sorting-center sentences of
 * EcoScooting that Cainiao relays ("Your shipment has arrived at sorting
 * center") are on Madrid's clock as well, as EcoScooting's own are, also for a
 * parcel bound for Portugal.
 *
 * 4PX's page (2026-10-11, two parcels to the US) dates its scans up to the
 * departing flight on China time and the rest in the US. Its destination
 * partner's sorting center, which a parcel to France reaches before any
 * placed scan, is on the destination's clock there. EcoScooting's own
 * instants (two parcels) put its China leg on China time, its order and its
 * Spanish sorting center on Madrid's, and its last mile on the destination's:
 * Lisbon's for a "CNPRT" reference, otherwise Spain's.
 *
 * MailAmericas' older tracker gave each scan its site's offset, China's for
 * the origin leg and the Americas' after it. ParcelsApp relays the wall
 * clocks with no place before the destination's customs. Its Tax ID checks,
 * logged with the label, were dated up to six hours after ParcelsApp first
 * returned them on a parcel to Colombia, and come before that moment only on
 * China's clock, the parcel's origin (2026-10-16). Its scans in the
 * destination matched Cainiao's import customs to the minute on Colombia's,
 * and its "Container reception" AliExpress's own receipt by the local
 * delivery company, which states its offset.
 *
 * EMS's scans at the destination's office of exchange, from its arrival to its
 * departure, are on the destination's clock, as its origin leg is on the
 * origin's (`POSTAL_ORIGIN_LEG`): on a parcel from the UK to South Africa they
 * had the digits of the South African post's own copies, and its unplaced
 * "Held for customs inspection" those of UPU's "Held by customs" at the
 * Johannesburg office. Borrowed from the origin's scans before them, they came
 * an hour late. Its hold at that office ("Held at destination import office")
 * is the same office's scan. In a country of several clocks the office of
 * exchange is on the one most of its people live on, unless the country's
 * states or provinces keep their own: on a parcel to Chile, EMS's arrival and
 * import customs at "Santiago" had the digits of UPU's copies at "SANTIAGO
 * EMS, Chile" and FIC's own rows on Santiago's clock. Its last mile
 * (`EMS_LAST_MILE`), at a postcode or a town, is in the destination too, on
 * its single clock: borrowed from the export office, a round in France went
 * out on Beijing's clock, before the item left the import office.
 *
 * FIRST LINE's ("1ST") scans from its arrival at the destination airport are
 * on the destination's clock, as its partner's scans after them are (see
 * `WALL_CLOCKS`). Borrowed from its scans in Shenzhen, they came 15 hours
 * early on a parcel to California.
 *
 * USPS's inbound customs scans, which it gives no place, are at its
 * international service centre in the US: borrowed from its origin leg's
 * departure from the UK, the release from customs at Los Angeles came eight
 * hours early, before Royal Mail's copy of its receipt there.
 *
 * A scan on a fixed clock borrows no neighbour's: borrowed from a GOFO
 * parcel's Florida scans, the label came 3 hours early and Cainiao's "Order
 * received" 12 hours after it, 19 seconds on China time. One in the
 * destination borrows only from a scan placed there, and otherwise takes its
 * single clock (`wallClockZones`).
 */
const KNOWN_CLOCKS: ReadonlyMap<string, readonly {
  wording: RegExp; zone: string; except?: string; otherwise?: string; via?: Readonly<Record<string, string>>; to?: string;
  among?: ReadonlySet<string>; main?: boolean;
}[]> = new Map([
  ['gofoexpress', [
    { wording: /^shipping label created$/i, zone: 'America/Toronto', to: 'CA' },
    { wording: /^shipping label created$/i, zone: 'America/Los_Angeles' },
  ]],
  ['cainiao', [
    { wording: wordings(CAINIAO_CHINA_LEG), zone: CAINIAO_CHINA_ZONE },
    // The consolidation warehouse's arrival and receipt in ParcelsApp's words, which Cainiao states +08:00.
    { wording: wordings(['arrived at warehouse', 'received by warehouse']), zone: CAINIAO_CHINA_ZONE },
    { wording: wordings(['import clearance start', 'import customs clearance complete', 'arrived at customs', 'leaving customs',
      'we\'re inspecting your order']), zone: DESTINATION, via: { PT: 'ES' }, main: true },
    { wording: wordings(['arrived at linehaul office']), zone: 'Europe/Paris', among: EUROPE },
    { wording: wordings(['arrived at linehaul office']), zone: DESTINATION, main: true },
    { wording: wordings(['your shipment has arrived at sorting center', 'your shipment has been processed at sorting center and ready for shipping']),
      zone: 'Europe/Madrid' },
    { wording: wordings(CAINIAO_LAST_MILE), zone: DESTINATION, except: 'GB' },
    { wording: wordings(['arrive at transit country or facility', 'parcel outbound from transit facility', 'depart from transit country or district']),
      zone: 'Europe/Paris', among: EUROPE },
  ]],
  ['mailamericas', [
    { wording: /^(?:order created|tax id|origin warehouse)\.|^transit to destination country\. (?:on the way to the airport|origin customs|flight)$/i,
      zone: ORIGIN },
    { wording: /^(?:arrived at destination country|destination customs|wi\s*[–-]\s*intermediate warehouse|receiving destination mail|received in destination office|delivery (?:branch|office)|finished)\.|^delivered\b|^container reception$/i,
      zone: DESTINATION },
  ]],
  ['4pxexpress', [
    { wording: wordings(['parcel information received', 'pickup scanned, in transit to warehouse', 'shipment picked up\\.?',
      'shipment arrived at facility and measured\\.?', 'depart from facility to service provider\\.?', 'hand over to airline\\.?',
      'departure from the original airport']), zone: 'Asia/Shanghai' },
    { wording: wordings(['arrival to the destination airport', 'arrived at warehouse', 'released from customs: customs cleared\\.?',
      'customs clearance agent received the shipment in destnation country\\.?', 'in transit, it\'s progressing through post network',
      'handed over to last mile', 'your shipment has been processed at sorting center and ready for shipping']), zone: DESTINATION },
  ]],
  ['1st', [
    { wording: wordings(['arrived at destination airport', 'import scan', 'released from customs: customs cleared\\.?',
      'departed from destination facility']), zone: DESTINATION },
  ]],
  ['ems', [
    { wording: wordings(['arrived at destination import office', 'held at destination import office', 'held for customs inspection',
      'presented to import customs', 'released from import customs', 'departed from destination import office']), zone: DESTINATION,
      main: true },
    { wording: EMS_LAST_MILE, zone: DESTINATION },
  ]],
  ['usps', [
    { wording: /^inbound (?:into|out of) customs$/i, zone: DESTINATION, to: 'US' },
  ]],
  ['ecoscooting', [
    { wording: /^(?:shipment data information received|shipment has left cainiao express's partner facility|shipment is in transit to cainiao express)$/i,
      zone: 'Asia/Shanghai' },
    { wording: /^(?:create|sorting center (?:inbound|outbound))\./i, zone: 'Europe/Madrid' },
    { wording: /^(?:accepted by last mile|out for delivery|delivery attempt failure|delivery success|pudo inbound success|delivered to pudo)\./i,
      zone: DESTINATION, otherwise: 'Europe/Madrid' },
  ]],
]);

/**
 * A scan's known clock: its zone, null when the destination or origin has
 * several, and for a scan in the destination, that country, or the one `via`
 * names for it. `port` marks an office of exchange in a country whose states
 * or provinces keep their own clocks: it is on its port of entry's, which no
 * row names.
 */
function knownClock(name: unknown, status: string, destination: string | null, origin: string | null = null): { zone: string | null; country?: string; port?: boolean } | null {
  const known = KNOWN_CLOCKS.get(nameKey(name))?.find(({ wording, to, among }) => wording.test(status.trim())
    && (!to || to === destination) && (!among || among.has(destination ?? '')));
  if (known?.zone === ORIGIN) return origin ? { zone: countryTimeZone(origin) } : null;
  if (!known || known.zone !== DESTINATION) return known ? { zone: known.zone } : null;
  if (!destination) return known.otherwise ? { zone: known.otherwise } : null;
  if (destination === known.except) return null;
  const country = known.via?.[destination] ?? destination;
  const single = countryTimeZone(country);
  if (single) return { zone: single, country };
  if (known.main && REGIONAL_CLOCKS.has(country)) return { zone: null, country, port: true };
  return { zone: known.main && hasSeveralClocks(country) ? mainZone(country) : null, country };
}
/**
 * Networks whose dates are their home clock wherever the scan was: their own
 * instants or labels shown on that clock, checked on 2026-10-10. Italy Post's
 * are Poste Italiane's epoch milliseconds on Rome time. New Zealand Post's
 * are NZ Post's UTC instants on Auckland time, also for the scans it relays
 * from abroad ("Hong Kong"). Singapore Post's are SingPost's "+08:00" digits,
 * also for its scans in China, and SunYou's those of its feed's origin leg,
 * on "+08:00". Landmark Global's are its tracking page's US Central clock,
 * also for the delivery partner's scans it relays: guessed from the check's
 * zone instead, the same scan moved by two hours. Royal Mail's and
 * Parcelforce's are the labels of Royal Mail's tracker on London time, at
 * home and beyond Europe: a South African office's scans have the instants of
 * the South African post's own clock that way. Their European partners'
 * relays keep another clock (`royalMailRelay`).
 */
const HOME_CLOCKS: Readonly<Record<string, string>> = {
  italypost: 'Europe/Rome', landmarkglobal: 'America/Chicago', newzealandpost: 'Pacific/Auckland', singaporepost: 'Asia/Singapore',
  sunyousytrack: 'Asia/Shanghai', royalmail: 'Europe/London', parcelforce: 'Europe/London', parcelforceworldwide: 'Europe/London',
};
/**
 * Correios Brazil's dates, under any of its names, are Brasília's clock for
 * its own rows: its tracker gives them America/Sao_Paulo, and 17TRACK's -03:00
 * copies in Curitiba have ParcelsApp's digits. Brazil keeps several zones, so
 * its scans otherwise kept the UTC label. The sending post's rows it relays
 * ("Country, CHINA") are that post's (`RELAYING_POSTS`).
 */
const CORREIOS_BRAZIL_CLOCK = 'America/Sao_Paulo';
/**
 * Shopee Express Brazil's dates are on Shopee's UTC+8 clock under a UTC label,
 * wherever in Brazil the scan was: SPX's own tracker dates the same scans, to
 * the second, eight hours earlier as instants. Brazil's clock would put them
 * eleven hours late.
 */
const SHOPEE_BRAZIL_CLOCK = 'Asia/Singapore';
/**
 * CTT Express's scans at its offices ("C.O. EXAMPLE B10") are on Madrid's
 * clock under a UTC label: its own tracker states them with Madrid's offset,
 * and read as UTC ParcelsApp's copies came an hour late. Its offices place no
 * scan, and the catalog's UTC is only its tracker's label. A row without an
 * office has the instant its own tracker states: read on Madrid's clock, a
 * parcel's posting and dispatch came one or two hours early.
 */
const CTT_EXPRESS_CLOCK = 'Europe/Madrid';
/**
 * SunYou's feed dates its destination leg, from the arrival at the
 * destination's airport, on the destination's clock: "+02:00" for a parcel to
 * Spain, where ParcelsApp has the same digits and EcoScooting's own instants
 * agree. Those scans take the destination's single clock, or else only a guess.
 */
const SUNYOU_DESTINATION_LEG = /^(?:arrived at destination country airport|customs clearance\b|hand over to last mile|arrived at the processing center of the last mile provider|out for delivery|delivery in progress|delivery failed|delivered\b)/i;
/**
 * Speedaf's own feed dates each scan on its site's clock: China's up to the
 * departing flight ("Cargo flight departured"), then the destination's.
 * ParcelsApp keeps the digits under a UTC label, and its Cainiao copies of the
 * same scans agree once read that way. A scan whose digits come after the
 * flight's is in the destination, which gives it a zone if it has one clock.
 */
/** The wordings of the states ParcelsApp files under EasyShip, the name it gives ePost Global's feed. */
function feedWordings(payload: Record<string, unknown>): string[] {
  return (Array.isArray(payload.states) ? payload.states : []).flatMap((raw: unknown) =>
    isRecord(raw) && typeof raw.status === 'string' && nameKey(stateCarrierName(payload, raw)) === 'easyship' ? [raw.status] : []);
}
function speedafDeparture(payload: Record<string, unknown>): string | undefined {
  return (Array.isArray(payload.states) ? payload.states : []).flatMap((raw: unknown) => {
    const name = isRecord(raw) ? stateCarrierName(payload, raw) : undefined;
    return isRecord(raw) && typeof name === 'string' && carrierIdFromName(name) === 'speedaf' && typeof raw.status === 'string'
      && /^cargo flight depart(?:ed|ured)$/i.test(raw.status.trim()) ? [mislabeledWallTime(raw.date) ?? ''] : [];
  }).sort().at(-1) || undefined;
}
function speedafZone(payload: Record<string, unknown>, date: unknown, destination: string | null): string | undefined {
  const wall = mislabeledWallTime(date);
  const departed = speedafDeparture(payload);
  if (!wall || !departed || wall <= departed) return 'Asia/Shanghai';
  return countryTimeZone(destination) ?? undefined;
}
/**
 * SwiftX's dates are its sites' wall clocks: its own tracker gives each scan
 * its site's offset, which follows daylight saving time (carriers/swiftx).
 * ParcelsApp keeps the digits under a UTC label and writes the site after the
 * country and town, with no state ("US, EXAMPLE TOWN, EWR HUB"). SwiftX names
 * its sites by airport code, and a site listed here gives its zone: its EWR
 * hub's digits, read on Eastern time, have to the second the instants of
 * DHLink's copies of the same scans, which DHLink dates on China's clock, and
 * its New Jersey warehouse's those SwiftX's own tracker gives. Its ORD hub,
 * at Chicago O'Hare, is on Central time: KTD files its scans at the same
 * digits under the hub's town and state. Its DFW hub and warehouses, under
 * towns around Dallas and Fort Worth and in Austin, send out deliveries in
 * Texas, all on Central time. A delivery or
 * failed delivery names the recipient's town and no site ("US, EXAMPLE TOWN"):
 * SwiftX's tracker gives it the offset of the warehouse that sent the parcel
 * out, so it takes the zone of the newest listed site scanned before it.
 * Other sites keep SwiftX's catalog zone, Pacific. Its labels ("Shipping Label
 * Created", at "US, SYSTEM, SYSTEM") carry GMT-07:00 in every season in its
 * own tracker, and keep that clock wherever they are.
 */
const SWIFTX_SITES: ReadonlyMap<string, string> = new Map([
  ['EWR HUB', 'America/New_York'], ['EWR_NJ WAREHOUSE', 'America/New_York'], ['ORD HUB', 'America/Chicago'],
  ['DFW HUB', 'America/Chicago'], ['DFW_DC WAREHOUSE', 'America/Chicago'], ['DFW_AUS WAREHOUSE', 'America/Chicago'],
]);
const SWIFTX_LABEL = /^shipping label created$/i;
const SWIFTX_LABEL_CLOCK = 'UTC-7';
// A site can come with its ZIP code after it, alone: "EWR HUB 07008".
function swiftxListedZone(location: string): string | null {
  const site = location.split(',').at(-1)?.trim().replace(/\s+/g, ' ').replace(/ \d{5}$/, '').toUpperCase();
  return (site && SWIFTX_SITES.get(site)) || null;
}
function swiftxSiteZone(payload: Record<string, unknown>, state: Record<string, unknown>, location: string): string | null {
  const listed = swiftxListedZone(location);
  if (listed || location.split(',').length !== 2) return listed;
  const at = Date.parse(String(state.date));
  let newest: { at: number; zone: string } | null = null;
  for (const raw of Array.isArray(payload.states) ? payload.states : []) {
    if (!isRecord(raw) || raw === state) continue;
    const name = stateCarrierName(payload, raw);
    const zone = typeof name === 'string' && carrierIdFromName(name) === 'swiftx' ? swiftxListedZone(scanLocation(name, raw.location)) : null;
    const scanned = Date.parse(String(raw.date));
    if (zone && scanned <= at && (!newest || scanned > newest.at)) newest = { at: scanned, zone };
  }
  return newest?.zone ?? null;
}
/**
 * On SwiftX's own number and a parcel to the US, DHLink's feed relays SwiftX's scans at
 * SwiftX's digits: under the town and state ("EXAMPLE TOWN, California, United States") they
 * have the second of SwiftX's own hub rows, and DHLink records them hours after a US reading
 * of their clocks, half a day after China's. Such a row takes its state's clock (`siteZone`),
 * and DHLink's only label row SwiftX's label clock. Its other rows keep China's.
 */
function swiftxRelayed(number: string, destination: string | null): boolean {
  return destination === 'US' && (detectCarrierMatch(number).candidates as readonly string[]).includes('swiftx');
}
/** The clock of a US town and state, as DHLink's relays of SwiftX's scans name them. */
function usStateClock(location: string): string | null {
  const region = countryCode(lastPlace(location)) === 'US' ? regionClock(location) : null;
  return region?.certain ? region.zone : null;
}
/** Whether DHLink's feed holds one label row: beside DHLink's own, SwiftX's copy goes (`dropDhlinkCopies`). */
function soleDhlinkLabel(payload: Record<string, unknown>): boolean {
  return (Array.isArray(payload.states) ? payload.states : []).filter((raw: unknown) => {
    const name = isRecord(raw) ? stateCarrierName(payload, raw) : undefined;
    return isRecord(raw) && typeof name === 'string' && carrierIdFromName(name) === 'dhlink' && SWIFTX_LABEL.test(relayedLabel(raw.status).trim());
  }).length === 1;
}
// A UPU office of exchange in Portugal leading a CTT location: "PTLISB - (OUTRO) LISBON PROV".
const CTT_HOME_OFFICE = /^PT[A-Z0-9]{4}\s+-\s/;
/**
 * CTT's copies keep the digits of CTT's own tracker, whose Z is no offset:
 * the wall clock where the scan happened (carriers/ctt/clock.ts). ParcelsApp
 * drops CTT's event codes, so its offices of exchange tell the side of the
 * border: an office or a CTT site names its own clock; on mail from abroad, a
 * scan before the first at a Portuguese office is the origin post's, and on a
 * parcel bound abroad, one after the last is the destination post's; any
 * other is on Portugal's clock.
 */
function cttZone(payload: Record<string, unknown>, location: string, date: unknown, number: string, destination: string | null): string | undefined {
  const origin = replyOrigin(payload, number);
  const site = cttSiteZone(location, [origin, destination]);
  if (site) return site;
  const wall = mislabeledWallTime(date);
  const home = (Array.isArray(payload.states) ? payload.states : []).flatMap((raw: unknown) => {
    const name = isRecord(raw) ? stateCarrierName(payload, raw) : undefined;
    return isRecord(raw) && typeof name === 'string' && carrierIdFromName(name) === 'ctt' && typeof raw.location === 'string'
      && CTT_HOME_OFFICE.test(raw.location.trim()) ? [mislabeledWallTime(raw.date) ?? ''] : [];
  }).filter(Boolean).sort();
  const partner = !wall ? null : origin && origin !== 'PT' && (!home.length || wall < home[0]!) ? origin
    : origin === 'PT' && destination && destination !== 'PT' && home.length && wall > home.at(-1)! ? destination : null;
  return (partner ? countryTimeZone(partner) : portugalZone(location)) ?? undefined;
}
/**
 * Networks whose dates are their scans' local clocks, checked at home only
 * (2026-10-10): Korea Post's page and Bring's offsets (in Denmark too);
 * Japan Post's, which its portal gives as local times, at 10:27 for a delivery
 * in Japan that Cainiao dates 10:27 GMT+9 and Ship24 01:27Z (2026-10-11). Pekaes' are the offset-less digits its own
 * history gives and its page labels Polish time (2026-10-13). Yodel's, InPost's
 * UK network, are London's: InPost's own offsets give the same instants
 * (2026-10-16), as they do for Collect+'s, PayPoint's shop network, which Ship24
 * dates "+01:00" in summer. XZG's, a Shenzhen line provider's, are China's:
 * XZG's own tracker and DHLink's, which relays it, give the same digits, and
 * DHLink records its warehouse scans within seconds on its system clock,
 * which is China's. On that clock XZG's scans stay one with DHLink's copies,
 * which take DHLink's catalog zone, whether or not a reply has them and
 * whatever zone routing passes. LIB's, LiBaoTongXu's, a Putian line provider
 * whose US line DHLink carries, are China's too: its warehouse receipt had the
 * digits of DHLink's own row of it, on Beijing time, and read at its site code
 * ("PT") as Portugal, it came eight hours late. Saudi Post's (SPL's) are Riyadh's at home and
 * their place's abroad: its own tracker dates an origin post's scans and an EMS
 * partner's on their own place's clock (carriers/saudi-post), and its copy of
 * a departure from Sydney has the digits of EMS's there. "BRT Bartolini"'s,
 * with or without the identifier type in brackets, are Rome's: they have the
 * digits of BRT's own page, which writes its depots' Italian wall clocks
 * (2026-10-21). The South African post's are Johannesburg's at home and their
 * place's abroad: on a parcel from the UK, its copy of the departure from the
 * British office of exchange had the digits of Royal Mail's own scan on London
 * time, and read on Johannesburg's, its arrival there came at the instant of
 * Parcelforce's label read on London's. "Yanwen Logistics"'s are China's: its
 * place-less shipment information came at the minute of Yanwen's own row,
 * stated +08:00, under ParcelsApp's UTC label. Emirates Post's, which ParcelsApp
 * files as "Emirates Post Group", are Dubai's: its own tracker gives the same
 * scans at the same digits, on Dubai's clock where it names a UAE city, and
 * read as labeled they came four hours late, after the UPU's copies of them.
 * One naming a UAE city is placed there (`siteZone`). Their home clock is a guess,
 * which a location in another country rules out.
 */
const HOME_COUNTRIES: Readonly<Record<string, string>> = {
  southkoreapost: 'Asia/Seoul', postennorgenorwaypost: 'Europe/Oslo', japanpost: 'Asia/Tokyo',
  pekaes: 'Europe/Warsaw', yodel: 'Europe/London', inpostuk: 'Europe/London', collect: 'Europe/London', xzg: 'Asia/Shanghai', lib: 'Asia/Shanghai',
  spl: 'Asia/Riyadh', saudipost: 'Asia/Riyadh', yanwenlogistics: 'Asia/Shanghai',
  brtbartolini: 'Europe/Rome', brtbartoliniparcelid: 'Europe/Rome', brtbartolinidpd: 'Europe/Rome',
  southafricapostoffice: 'Africa/Johannesburg', southafricapost: 'Africa/Johannesburg',
  emiratespost: EMIRATES_POST_ZONE, emiratespostgroup: EMIRATES_POST_ZONE,
};
/**
 * Royal Mail relays its partners' scans abroad on a clock twice the UK's offset
 * ahead of UTC, whatever the country's own clock (`royalMailRelayClock`): Central
 * European time in summer, UTC in winter. On a parcel to France in summer, its
 * receipt and departure at the French office of exchange had the digits of La
 * Poste's own scans, Paris time; on one to Portugal, its "Item Received" and
 * customs scans came an hour after CTT's own digits, Lisbon time, at the same
 * minute. In winter, La Poste's, Poste Italiane's and Poczta Polska's own scans
 * came an hour after Royal Mail's digits. A scan
 * located in another European country is such a relay, and so is one in Royal
 * Mail's words for the destination ("Your item is currently with Customs in the
 * destination country.") on a parcel bound there, with no place or a partner's
 * bare facility name, as Royal Mail's own adapter reads it. Beyond Europe, the
 * label is on London time (`HOME_CLOCKS`).
 */
const ROYAL_MAIL_NAMES = new Set(['royalmail', 'parcelforce', 'parcelforceworldwide']);
function royalMailRelay(location: string, status: string, destination: string | null): boolean {
  const country = countryCode(lastPlace(location));
  return country ? europeanAbroad(country) : destinationRelay(location, status, destination);
}

/** The zone a Royal Mail partner's place names in `country`: a USPS facility's state, or a town's. */
function royalMailPartnerPlaceZone(location: string, country: string): string | null {
  const named = location.split(',');
  const site = named.length > 1 && countryCode(named.at(-1)!.trim()) === country ? named.slice(0, -1).join(',').trim() : location;
  const facility = country === 'US' ? uspsScanZone(site) : null;
  if (facility) return facility;
  const found = site === location && countryCode(location) === country ? null : locatePlace(site, { countries: [country] });
  return found?.country === country && (found.precision === 'city' || found.region) ? placeTimeZone(found) : null;
}

const partnerZoneCache = new WeakMap<Record<string, unknown>, Map<string, string | null>>();
/** The one zone Royal Mail's partner rows of a reply place in each such country, or null where they place none or several. */
function royalMailPartnerZones(payload: Record<string, unknown>): Map<string, string | null> {
  const cached = partnerZoneCache.get(payload);
  if (cached) return cached;
  const zones = new Map<string, Set<string>>();
  for (const state of Array.isArray(payload.states) ? payload.states : []) {
    if (!isRecord(state) || !ROYAL_MAIL_NAMES.has(nameKey(stateCarrierName(payload, state)))) continue;
    const location = typeof state.location === 'string' ? state.location.trim() : '';
    const country = royalMailPartnerCountry(location);
    const zone = country ? royalMailPartnerPlaceZone(location, country) : null;
    if (country && zone) zones.set(country, (zones.get(country) ?? new Set()).add(zone));
  }
  const single = new Map([...zones].map(([country, found]) => [country, found.size === 1 ? [...found][0]! : null] as const));
  partnerZoneCache.set(payload, single);
  return single;
}

/**
 * A Royal Mail row at a partner's office in a country whose offices Royal Mail labels with one
 * offset, the United States' or Australia's (carriers/royal-mail/clock.ts): ParcelsApp has that
 * label's instant on London's clock, so its digits go back to the office's wall clock, read on its
 * place's clock. A row that names only the country takes the one zone Royal Mail's other rows
 * there place, as its "Released from Customs" in the United States takes the clock of its receipt
 * at the international service centre; with none, or several, it keeps the wall clock (null).
 */
function royalMailPartnerRelay(payload: Record<string, unknown>, name: unknown, date: unknown, location: unknown): {
  zone: string | null; date: string; basis: 'place' | 'neighbour';
} | null {
  if (!ROYAL_MAIL_NAMES.has(nameKey(name))) return null;
  const place = typeof location === 'string' ? location.trim() : '';
  const country = royalMailPartnerCountry(place);
  const label = country ? mislabeledLocalTime(date, 'Europe/London') : null;
  const wall = country && label ? royalMailPartnerWall(country, DateTime.fromISO(label.iso, { setZone: true })) : null;
  if (!country || !wall) return null;
  const placed = royalMailPartnerPlaceZone(place, country);
  return { zone: placed ?? royalMailPartnerZones(payload).get(country) ?? null, date: `${wall}Z`, basis: placed ? 'place' : 'neighbour' };
}
/**
 * Pitney Bowes's catalog clock, London's, is only its UK hub's. Its tracker
 * writes the other scans as Pitney Bowes's own adapter reads them:
 * - Interpost's import declaration and clearance, with the country they name
 *   alone as their place ("Customs Clearance" at "IT", "B2C ClearanceStatus4"
 *   at "NL"), on that country's clock;
 * - the platform's scans with no place at the hub's processing ("In Transit",
 *   "Item processed at Interpost", the hand-over), on their own fixed clocks
 *   (`pitneyBowesPlatformClock`);
 * - the destination post's scans it relays with no place
 *   (`pitneyBowesPostalRelay`), on that post's clock: the destination's single
 *   clock, else their wall clock. Its copies of Poste Italiane's delivery have
 *   the digits of Poste's own instant on Rome time.
 * Read on London's clock, all of them were an hour or two off Pitney Bowes's
 * own rows. TrackYourParcel, B2C Europe's tracker, relays the same scans at the
 * same digits in its own words and with no place ("Customs Clearance. Customs
 * Import submitted", "Shipped. Departure to country of destination"), so its
 * copy takes the clock of Pitney Bowes's scans at the same minute, when they
 * agree. Undefined leaves a scan to the hub's clock, or for TrackYourParcel to
 * the steps; a null zone keeps the wall clock.
 */
const INTERPOST_CUSTOMS = /^(?:customs clearance|b2c clearance ?(?:status ?)?\d{1,3})\b/i;
function pitneyBowesOwnClock(state: Record<string, unknown>, status: string, destination: string | null): { zone: string | null } | undefined {
  const location = typeof state.location === 'string' ? state.location.trim() : '';
  const country = /^[A-Z]{2}$/.test(location) && INTERPOST_CUSTOMS.test(status) ? countryCode(location) : null;
  const declared = country ? mainZone(country) : null;
  if (declared) return { zone: declared };
  if (location) return undefined;
  const platform = pitneyBowesPlatformClock(status);
  if (platform) return { zone: platform };
  return pitneyBowesPostalRelay(status) ? { zone: countryTimeZone(destination) } : undefined;
}
function pitneyBowesClock(payload: Record<string, unknown>, state: Record<string, unknown>, status: string,
  destination: string | null): { zone: string | null } | undefined {
  const network = nameKey(stateCarrierName(payload, state));
  if (network === 'pitneybowes') return pitneyBowesOwnClock(state, status, destination);
  if (network !== 'trackyourparcel') return undefined;
  const wall = mislabeledWallTime(state.date);
  const clocks = new Set((Array.isArray(payload.states) ? payload.states : []).flatMap((scan: unknown) => {
    if (!isRecord(scan) || wall === null || mislabeledWallTime(scan.date) !== wall || nameKey(stateCarrierName(payload, scan)) !== 'pitneybowes') return [];
    const clock = pitneyBowesOwnClock(scan, relayedLabel(scan.status), destination);
    return clock ? [clock.zone] : [];
  }));
  const [zone] = [...clocks];
  return clocks.size === 1 ? { zone: zone ?? null } : undefined;
}
const UNITED_STATES = /^(?:us|usa|united states(?: of america)?)$/i;
const POSTAL_CODE = /\s*\b(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/i;
// A country's code before a postcode, as FedEx ends a location: "EXAMPLE TOWN, RR, IT 12345".
const COUNTRY_POSTCODE = /^([A-Z]{2})\s+(?=[A-Z\d -]*\d)[A-Z\d][A-Z\d -]{1,9}$/;
// USPS facilities, their kind after their state, as USPS's adapter reads them: "EXAMPLE CITY IL
// DISTRIBUTION CENTER", "EXAMPLE CITY LA PROCESSING CENTER", "ISC EXAMPLE CITY IL (USPS)".
const US_FACILITY = new RegExp(String.raw`\s+${USPS_FACILITY_KIND}$`, 'i');
// States written out, as Orange Connex does for SpeedPAK ("Example City Minnesota, United States").
const US_STATE_NAMES: ReadonlyMap<string, string> = new Map(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', districtofcolumbia: 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', newhampshire: 'NH', newjersey: 'NJ', newmexico: 'NM', newyork: 'NY',
  northcarolina: 'NC', northdakota: 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  rhodeisland: 'RI', southcarolina: 'SC', southdakota: 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', westvirginia: 'WV', wisconsin: 'WI', wyoming: 'WY',
}));

/**
 * The zone of the US state or Canadian province a location names ("Riverside,
 * CA, US", "Charlotte, NC", "Linden, NJ 12345", "Scranton PA", "Mississauga,
 * ON, CA", "Example City, IN, US 12345"). It is `certain` when the location
 * names the country, the code is no country's, the town lies in that state
 * or province ("Chicago, IL" is not in Israel), or a ZIP code of that state
 * follows it; "Atlanta, GA" could still be
 * in Gabon. A state written out counts only after the country ("Example City
 * Minnesota, United States"): Georgia is a country too.
 */
function regionClock(location: string, distrusted: ReadonlySet<string> = NO_CODES): { zone: string; certain: boolean; distrusted?: string } | null {
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  const last = parts.at(-1) ?? '';
  const coded = parts.length > 2 ? COUNTRY_POSTCODE.exec(last)?.[1] : undefined;
  // "CA" after a province is Canada; after a town it is California.
  const country = parts.length > 1 && UNITED_STATES.test(last.replace(POSTAL_CODE, '')) ? 'US'
    : (parts.length > 1 && /^canada$/i.test(last)) || (parts.length > 2 && /^ca$/i.test(coded ?? last)) ? 'CA' : null;
  if (country) parts.pop();
  if (parts.length > 1 && !parts.at(-1)!.replace(POSTAL_CODE, '')) parts.pop();
  // "Example City, BE, NL" and "EXAMPLE CITY, BE, NL 1234": a region, then some other country.
  if (!country && parts.length > 2 && [parts.at(-2)!, coded ?? parts.at(-1)!].every((part) => /^[A-Z]{2}$/i.test(part))) return null;
  const words = (parts.at(-1) ?? '').replace(POSTAL_CODE, '').replace(US_FACILITY, '').split(/\s+/);
  // A town keeps its own clock where part of its state keeps another: Florida's Panhandle is on Central time.
  const stateClock = (state: string, town: string) => splitRegionTownZone('US', state, town) ?? usStateTimeZone(state);
  if (country === 'US') {
    const size = [3, 2, 1].find((count) => words.length >= count && US_STATE_NAMES.has(nameKey(words.slice(-count).join(''))));
    const state = size ? US_STATE_NAMES.get(nameKey(words.slice(-size).join('')))! : '';
    if (size) return { zone: stateClock(state, words.slice(0, -size).join(' ') || (parts.length > 1 ? parts.at(-2)! : ''))!, certain: true };
  }
  const code = parts.length > 1 || words.length > 1 ? words.at(-1)! : '';
  const town = parts.length > 1 ? parts.at(-2)! : words.slice(0, -1).join(' ');
  const zone = (country === 'CA' || !usStateTimeZone(code) ? null : stateClock(code.toUpperCase(), town))
    ?? (country === 'US' ? null : canadaProvinceTimeZone(code));
  // A ZIP code of that state settles it: "EXAMPLE TOWN, CA 90001" is California's.
  const zip = /\b(\d{5})(?:-\d{4})?$/.exec(last)?.[1];
  const zipped = !!zip && usZipState(zip) === code.toUpperCase();
  // A code the reply's own origin or destination also names (`replyCodes`) needs its town, its ZIP code or the country.
  const shared = distrusted.has(code.toUpperCase());
  const certain = country !== null || (!shared && !countryCode(code)) || regionHasTown(code, town) || zipped;
  return zone ? { zone, certain, ...(shared ? { distrusted: code.toUpperCase() } : {}) } : null;
}

const NO_CODES: ReadonlySet<string> = new Set();

/**
 * The codes a country at one end of the reply gives its own places, which a state or province
 * shares: its own code ("Casablanca, MA" on a parcel bound for Morocco), and Australia's "WA"
 * and "NT". None for the US or Canada.
 */
function ownCountryCodes(country: string | null): string[] {
  if (!country || country === 'US' || country === 'CA') return [];
  return country === 'AU' ? ['WA', 'NT'] : [country];
}

/**
 * The codes a scan's place is distrusted for as a state or province: the origin's before the
 * reply's first scan certainly in North America, the destination's after its last. With no
 * such scan, an end's codes count unless the other end is the US or Canada.
 */
function replyCodes(payload: Record<string, unknown>, states: readonly unknown[], origin: string | null,
  destination: string | null): (date: unknown) => ReadonlySet<string> {
  const ends = new Set([...ownCountryCodes(origin), ...ownCountryCodes(destination)]);
  if (!ends.size) return () => NO_CODES;
  const certain = states.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const location = scanLocation(stateCarrierName(payload, raw), raw.location);
    const wall = location && placeKind(location, ends) === 'certain' ? mislabeledWallTime(raw.date) : null;
    return wall ? [wall] : [];
  }).sort();
  const northAmerican = (country: string | null) => country === 'US' || country === 'CA';
  return (date) => {
    const wall = mislabeledWallTime(date);
    const before = certain.length ? wall !== null && wall < certain[0]! : !northAmerican(destination);
    const after = certain.length ? wall !== null && wall > certain.at(-1)! : !northAmerican(origin);
    return new Set([...(before ? ownCountryCodes(origin) : []), ...(after ? ownCountryCodes(destination) : [])]);
  };
}

/**
 * The last part of a location that is not a bare postcode: "Example Town,
 * Denmark, 4600" is in Denmark. Orange Connex names China and the United
 * States in full for SpeedPAK, Canada Post writes "USA", 4PX "US 12345", and
 * Hong Kong is not the name Intl gives it. FedEx writes a town, its region and
 * the country's code before the postcode ("EXAMPLE TOWN, RR, IT 12345"), a
 * French département by its number ("EXAMPLE TOWN, 69, FR 12345"); with two
 * parts, "EXAMPLE TOWN, IN 12345" is a US state and its ZIP code. A US
 * military post office ("Fpo, AE") has none (`militaryPostOffice`).
 */
function lastPlace(location: string): string | undefined {
  if (militaryPostOffice(location)) return undefined;
  const named = location.split(',').map((part) => part.trim()).filter(Boolean);
  const parts = named.filter((part) => !/^\d[\d\s-]*$/.test(part));
  const place = parts.at(-1);
  if (!place) return place;
  const coded = named.length > 2 ? COUNTRY_POSTCODE.exec(place)?.[1] : undefined;
  return /^people['’]?s republic of china$/i.test(place) ? 'CN' : UNITED_STATES.test(place.replace(POSTAL_CODE, '')) ? 'US'
    : /^hong\s*kong$/i.test(place) ? 'HK' : coded ?? place;
}

/**
 * The origin post's scans as the postal feeds word them, UPU's and EMS's,
 * from posting to departure from its office of exchange (UPU's EMA to EMC and
 * EXA to EXD). They happen at the origin post, on its wall clock, wherever
 * their place is written in a script or a code no step reads ("GZSGJHHJ",
 * Guangzhou's office of exchange, or a postcode).
 */
const POSTAL_FEEDS = new Set(['universalpostalunion', 'upu', 'ems']);
const POSTAL_ORIGIN_LEG = wordings([
  'posting/collection', 'posted', 'item presented to export customs/security', 'presented to export customs and security',
  'item held by export customs/security', 'item returned from export customs/security', 'released from export customs and security',
  'arrived at export office', 'departed from export office', 'departed country of origin',
  '(?:arrival at|departure from|dispatch from|item held at) outward office of exchange',
]);
// The posting itself, UPU's "Posting/Collection" and EMS's "Posted" (EMA).
const POSTAL_POSTING = wordings(['posting/collection', 'posted']);

/**
 * Whether a China Post scan is on Beijing's clock: its place is written in
 * Chinese ("示例市 12345678"), ends with a mainland province ("Example City,
 * Guangdong") or is one of the cities above alone ("Shenzhen"). China Post
 * dates those scans in China, as 17TRACK's "+08:00" copies of them show.
 */
function inChina(location: string): boolean {
  const place = nameKey(location.split(',').at(-1));
  return /\p{Script=Han}/u.test(location) || CHINESE_PROVINCES.has(place) || (!location.includes(',') && CHINESE_CITIES.has(place));
}

// China Post's own clock, Beijing's.
const CHINA_POST_ZONE = 'Asia/Shanghai';
// China Post's office abroad that hands it the destination post's scans.
const CHINA_POST_OFFICE_ABROAD = /境外经转局/u;
// China Post's own lines for a scan abroad, a processing centre there in brackets, its trunk transit or a
// clearance named by the destination's code, are on its own clock: China Post's tracker and 17TRACK give
// their digits "+08:00", and read on Paris's clock they came seven hours late.
const CHINA_POST_OWN_LINE_ABROAD = /^邮件(?:到达|离开)处理中心【[^】]{1,60}】$|^干线中转$|^customs clearance completed in [A-Z]{2}$/iu;
// iMile's scans as a Chinese forwarder copies them, the centre in brackets before a short step
// ("【…】received", not iMile's own "【…】Your order has been received."), are on Beijing's clock: in Italy
// each read seven hours ahead of iMile's own copy, and on Italy's clock the delivery round came after the lookup.
const IMILE_FORWARDER_COPY = /^【[^【】]{1,60}】\s*(?:received|arrived|parcel shipped to ?【[^【】]{1,60}】|shipment out for delivery)$/iu;
// 4PX is such a forwarder: ParcelsApp also files those copies under 4PX Express, with 4PX's hand-over
// to iMile, all of which 4PX's own feed dates "+08:00". Placed by the transit centre beside them, they
// came seven hours late.
const FOUR_PX_IMILE_HANDOVER = /^shipment delivered to imile rdc or lastmile vendor\.?$/i;
// MailAmericas's customs scans in the destination country, on that country's clock as its own adapter dates them
// ("Destination customs: Hand over to Last Mile Provider" at 20:31-03:00): ParcelsApp gives the digits marked UTC.
// Mexico's and Chile's states keep several clocks, so their scans are left as they were.
const MAILAMERICAS_DESTINATION_CUSTOMS = /^customs at destination\./i;
const MAILAMERICAS_DESTINATION_ZONES: Readonly<Record<string, string>> = {
  AR: 'America/Argentina/Buenos_Aires', CO: 'America/Bogota', PE: 'America/Lima',
};

/**
 * Whether a China Post scan is the destination post's: its place or wording
 * names the destination by the start of its Chinese name ("哥伦" for 哥伦比亚,
 * Colombia), or its office abroad ("Departed from 境外经转局"), or its place is
 * in the destination: the country by name, or a state or province on an item
 * bound for the US or Canada ("EXAMPLE CITY, NV 12345"). China Post copies
 * those scans with the destination post's digits: UPU's copies of them at the
 * destination's office of exchange have the same, to the minute.
 */
function chinaPostAbroad(location: string, status: string, destination: string | null): boolean {
  if (CHINA_POST_OFFICE_ABROAD.test(status)) return true;
  if (!destination || destination === 'CN') return false;
  const country = countryName(destination, 'zh');
  return [location, status].some((text) => (text.match(/\p{Script=Han}{2,}/gu) ?? []).some((run) => country.startsWith(run)))
    || countryCode(lastPlace(location)) === destination || ((destination === 'US' || destination === 'CA') && regionClock(location) !== null);
}

/**
 * A scan's location as the zone steps read it. 4PX writes the country, state
 * and town in fixed fields ("US  NY  EXAMPLE CITY 12345", "US    EXAMPLE CITY
 * NY DISTRIBUTION CENTER"), read here as "EXAMPLE CITY 12345, NY, US". A
 * country of one clock that the scan reports only once its label or posting
 * postcode is read (`reportedPlace`: "Country: Poland", "PL99999") is read as
 * that country, so the clock agrees with the place the scan shows: read as no
 * place, La Poste's scans in Poland kept ParcelsApp's UTC label, two hours late.
 * 4PX's site codes, the country and the city's code ("USHOUA"), read as their town.
 * LiBaoTongXu's ("LIB") site code in Putian ("PT") names no country and places no scan.
 */
const LIB_SITES = new Set(['PT']);
const libSite = (name: unknown, location: unknown) => nameKey(name) === 'lib' && typeof location === 'string'
  && LIB_SITES.has(location.trim().toUpperCase());
const FOUR_PX_SITES: ReadonlyMap<string, string> = new Map([
  // 4PX's Houston operation point, which packs a parcel for GOFO before its Houston hub takes it in.
  ['USHOUA', 'Houston, TX, US'],
]);
function scanLocation(name: unknown, location: unknown): string {
  const text = typeof location === 'string' ? location.trim() : '';
  const reported = reportedPlace(text);
  if (!countryCode(lastPlace(text)) && countryTimeZone(reported)) return reported;
  if (libSite(name, text)) return '';
  if (nameKey(name) !== '4pxexpress') return text;
  const site = FOUR_PX_SITES.get(text.toUpperCase());
  if (site) return site;
  if (!/^[A-Z]{2}(?:\s{2}|$)/.test(text)) return text;
  const [country, ...fields] = text.split(/\s{2}/).map((field) => field.trim());
  return [...fields.reverse(), country].filter(Boolean).join(', ');
}

// Australia's states and territories by abbreviation, each on its capital's clock.
const AUSTRALIAN_STATE_ZONES: ReadonlyMap<string, string> = new Map([
  ['ACT', 'Australia/Sydney'], ['NSW', 'Australia/Sydney'], ['NT', 'Australia/Darwin'], ['QLD', 'Australia/Brisbane'],
  ['SA', 'Australia/Adelaide'], ['TAS', 'Australia/Hobart'], ['VIC', 'Australia/Melbourne'], ['WA', 'Australia/Perth'],
]);

// An Australian state and its four-digit postcode, ending a place: "EXAMPLE TOWN WA 6000".
const AUSTRALIAN_ADDRESS = /\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA),?\s+\d{4}$/;

// The countries of the US, Canadian and Australian zones a state or province gives.
const STATE_ZONES: ReadonlyMap<string, string> = new Map([
  ...[...US_STATE_NAMES.values()].map((code) => [usStateTimeZone(code)!, 'US'] as const),
  ...['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'].map((code) => [canadaProvinceTimeZone(code)!, 'CA'] as const),
  ...[...AUSTRALIAN_STATE_ZONES.values()].map((zone) => [zone, 'AU'] as const),
]);

// Australia's state capitals, by which the postal feeds name its offices ("SYDNEY EMS").
const AUSTRALIAN_CAPITALS: ReadonlyMap<string, string> = new Map([
  ['adelaide', 'SA'], ['brisbane', 'QLD'], ['canberra', 'ACT'], ['darwin', 'NT'],
  ['hobart', 'TAS'], ['melbourne', 'VIC'], ['perth', 'WA'], ['sydney', 'NSW'],
]);

/**
 * The clock of a scan in Australia, which has several: that of the state its
 * location names ("EXAMPLE TOWN NSW 2000"), else, with `capitals`, of the
 * state capital it names ("SYDNEY EMS, Australia"). It is read only for a scan
 * known to be in Australia, since "WA" and "SA" name other places too.
 */
function australianZone(location: string, capitals = true): string | null {
  const words = location.split(/[^A-Za-z]+/).filter(Boolean);
  const state = words.find((word) => AUSTRALIAN_STATE_ZONES.has(word))
    ?? (capitals ? words.map((word) => AUSTRALIAN_CAPITALS.get(word.toLowerCase())).find(Boolean) : undefined);
  return state ? AUSTRALIAN_STATE_ZONES.get(state)! : null;
}

/**
 * The clock of Australia Post's own scan in Australia. ParcelsApp copies the digits of Australia
 * Post's tracker, the clock of the scan's state, under a UTC label, and writes its place as a town
 * and state with no country ("EXAMPLE TOWN QLD"): its "Lodged by Sender" in Queensland came ten
 * hours after Australia Post's own instant, Brisbane's offset. A place in another country is not read here.
 */
function australiaPostZone(location: string): string | null {
  const country = countryCode(lastPlace(location));
  return !country || country === 'AU' ? australianZone(location) : null;
}

/**
 * Whether a scan is a postal feed's posting, whose place names the posting
 * office: in Australia that office's capital need not be the scan's state.
 */
function postalPosting(name: unknown, status: string): boolean {
  return POSTAL_FEEDS.has(nameKey(name)) && POSTAL_POSTING.test(status.trim());
}

/**
 * The clock of the capital a postal feed's posting in Australia names, which
 * is its office's and can be another state's than the scan's: UPU named
 * "BRISBANE" for the posting of an item Australia Post received in New South
 * Wales, at its "+11:00" there, Sydney's summer clock, where Brisbane keeps
 * "+10:00". EMS's copy, under the office's code, has the same digits. Such a
 * posting borrows its feed's clock first (`wallClockZones`), and only then
 * takes the capital's.
 */
function postingOffice(name: unknown, status: string, location: string, origin: string | null): string | null {
  const country = countryCode(lastPlace(location));
  return origin === 'AU' && (!country || country === 'AU') && postalPosting(name, status) ? australianZone(location) : null;
}

/**
 * A guessed zone, unless the location names a country it is not in: a guess
 * cannot put a scan in "Example City, South Africa" on Paris time. Guesses
 * from the name or from routing are single-clock countries' zones, so a
 * location in the US or Canada rules them out too. A borrowed zone can be a
 * state's or a province's, and must then be in the country the location names.
 * A US military post office can be anywhere in its region, so nothing fits it.
 */
function fitsPlace(zone: string | null, location: string, borrowed = false): string | null {
  if (militaryPostOffice(location)) return null;
  const country = countryCode(lastPlace(location));
  const zoneCountry = zone ? timeZoneCountry(zone) ?? (borrowed ? STATE_ZONES.get(zone) : undefined) : undefined;
  return zone && (!country || zoneCountry === country) ? zone : null;
}

/** Where a location puts a scan, for the reply-wide North America check. */
function placeKind(location: string, distrusted: ReadonlySet<string> = NO_CODES): 'certain' | 'region' | 'abroad' | null {
  const region = regionClock(location, distrusted);
  if (region?.certain) return 'certain';
  const place = lastPlace(location);
  if (countryTimeZone(place)) return 'abroad';
  if (region) return 'region';
  const country = countryCode(place);
  return country && country !== 'US' && country !== 'CA' ? 'abroad' : null;
}

/**
 * The state or province of a North American scan from a carrier whose dates
 * are local clocks. An uncertain one counts only in a reply that is in North
 * America.
 */
function regionScanZone(name: unknown, location: string, inNorthAmerica: boolean,
  distrusted: ReadonlySet<string> = NO_CODES): { zone: string; certain: boolean } | null {
  const key = nameKey(name);
  const region = LOCAL_CLOCK_CARRIERS.has(key) || WALL_CLOCKS.has(key) ? regionClock(location, distrusted) : null;
  return region && (region.certain || (inNorthAmerica && !region.distrusted)) ? region : null;
}

const POLAND_POST_RELAY = /^International Postal System$/i;

/**
 * The offset of a scan that carries one of its own. GOFO France's feed gives
 * the same instants, "+02:00" in summer (checked 2026-10-10); its US scans
 * come labeled UTC, on their local clock. Poland Post's scans at a place, a
 * Polish office or Poczta Polska's sender platform ("Electronic Sender"),
 * have the digits and offset of Poczta Polska's own tracker. Its relays from
 * abroad, with no place or at the "International Postal System", put
 * Poland's offset on the other country's clock, which its tracker leaves
 * without one. La Poste's scans it files at a country alone ("Country:
 * Poland", "PL99999") have La Poste's clock as UTC digits shifted into
 * Poland's offset: taken as given, they came two hours after La Poste's own.
 */
function ownOffset(name: unknown, date: unknown, location = ''): string | null {
  const key = nameKey(name);
  const own = key === 'gofoexpress'
    || (key === 'polandpost' && location !== '' && !POLAND_POST_RELAY.test(location) && !countryCode(location));
  const offset = own && typeof date === 'string' ? /[+-]\d{2}:\d{2}$/.exec(date.trim())?.[0] : undefined;
  return offset && !/^[+-]00:00$/.test(offset) ? offset : null;
}

/**
 * The clock of Poland Post's relay from abroad (`ownOffset`): the partner
 * post's, as Poczta Polska's own tracker reads it (`pocztaPolskaPartnerClock`),
 * with the digits as written. Taking Poland's offset off first put a Latvian
 * item's relayed scans two hours early on Riga's clock. With no partner clock
 * a relay keeps the reading it had.
 */
function polandPostRelay(name: unknown, date: unknown, location: string, number: string,
  destination: string | null): { zone: string; date: string } | null {
  if (nameKey(name) !== 'polandpost' || (location !== '' && !POLAND_POST_RELAY.test(location)) || typeof date !== 'string') return null;
  const written = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:\d{2})?$/i.exec(date.trim())?.[1];
  const partner = written ? pocztaPolskaPartnerClock(number, destination) : null;
  return written && partner ? { zone: partner.zone, date: `${written}Z` } : null;
}

// A tracked letter: an S10 number of the L series.
const TRACKED_LETTER = /^L[A-Z]\d{9}[A-Z]{2}$/;

/**
 * La Poste's copy of a sending post's scan on a tracked letter (`relayedPostZone`): La Poste shows
 * that post's wall clock read as UTC on Paris's clock, as 17TRACK has it, so its digits go back to
 * the wall clock before that post's clock reads them.
 */
function laPosteLetterRelay(name: unknown, date: unknown, location: string, number: string): { zone: string | null; date: string } | null {
  if (typeof name !== 'string' || carrierIdFromName(name) !== 'la-poste' || !TRACKED_LETTER.test(number) || !isValidS10TrackingNumber(number)) return null;
  const zone = relayedPostZone('la-poste', location);
  const wall = zone === undefined ? null : mislabeledLocalTime(date, 'Europe/Paris');
  return zone !== undefined && wall ? { zone, date: new Date(wall.timestamp).toISOString() } : null;
}

/**
 * Correos de México's copy of a foreign post's scan that it shows from that post's wall clock read
 * as UTC, on Mexico City's clock (carriers/correos-de-mexico/clock.ts): its digits go back to the
 * wall clock before that post's clock reads them.
 */
function correosDeMexicoRelay(name: unknown, date: unknown, location: string, origin: string | null, destination: string | null): { zone: string; date: string } | null {
  if (typeof name !== 'string' || carrierIdFromName(name) !== 'correos-de-mexico') return null;
  if (origin === 'MX' && destination === 'MX') return null;
  const foreign = correosDeMexicoForeignClock(location, date, origin === 'CO' || destination === 'CO');
  return foreign ? { zone: foreign.zone, date: `${foreign.wall}Z` } : null;
}

/**
 * The clock of the number's own network of a brand, when a country-qualified
 * name gives another: the depot prefix of a DPD UK number outweighs "DPD
 * France", the network ParcelsApp asked (checked 2026-10-10: DPD UK's own
 * page, Ship24 and 17TRACK put such scans on London time).
 */
function numberNetworkZone(carrier: string | undefined, number: string): string | null {
  const brand = carrier ? carrierBrand(carrier) : undefined;
  const own = brand ? brandCarrierForNumber(brand, number) : undefined;
  const zone = own && own !== carrier ? carrierTimezone(own) : 'UTC';
  return zone === 'UTC' ? null : zone;
}

/**
 * The clock of the network a parcel is filed under, when ParcelsApp names another network of a
 * brand whose networks answer for each other through one guest service, and the filed one
 * belongs to the brand only by a name of it ("DPD Brazil" for Jadlog): its numbers fall in no
 * depot range of the brand's. ParcelsApp names "DPD France" for a Jadlog parcel, whose own
 * rows have its digits on Sao Paulo's clock.
 */
function filedNetworkZone(carrier: string | undefined, filed: string | null): string | null {
  const brand = carrier ? carrierBrand(carrier) : undefined;
  if (!brand || !filed || !GROUP_LOOKUP_BRANDS.includes(brand) || carrierBrand(filed)) return null;
  const named = carrierDefinition(filed).aliases?.some((alias) => alias.toLowerCase().startsWith(`${brand} `)
    && carrierIdFromName(alias) === filed);
  const zone = named ? carrierTimezone(filed) : 'UTC';
  return zone === 'UTC' ? null : zone;
}

/**
 * The clocks a bare brand's scan with no location can be on when its catalog
 * networks keep several (DPD's, with the UK's): the clock of the network that
 * labelled the parcel, which the number asked or a number ParcelsApp names
 * next for it (`next_tracking_ids`) gives by its depot range, with the
 * destination's and, where the brand has a network that may have labelled
 * it, the origin's. A line carrier's parcel from China that DPD Switzerland
 * delivers names DPD's number next, and its "DPD Group" scan has the digits DPD
 * Switzerland's own tracker dates "+02:00". With no such number, or no
 * destination with one clock, there is none.
 */
function brandNetworkZones(payload: Record<string, unknown>, name: string, number: string, destination: string | null,
  origin: string | null): string[] {
  const next = Array.isArray(payload.next_tracking_ids) ? payload.next_tracking_ids : [];
  const numbers = [number, ...next.filter((id): id is string => typeof id === 'string' && id.length <= 40).slice(0, 10)];
  const labelled = new Set(numbers.flatMap((candidate) => brandCarrierForNumber(name, candidate) ?? []));
  const arrival = countryTimeZone(destination);
  if (!labelled.size || !arrival) return [];
  const fitting = new Set(numbers.flatMap((candidate) => detectCarrierMatch(candidate).candidates as readonly string[]));
  // An origin network that numbers its parcels only by its depot prefix, as DPD China does, labelled the
  // parcel only when a number carries that prefix: a line carrier's parcel from China is not DPD China's.
  const prefixed = (id: string) => carrierDefinition(id).detectionRules.length > 0 && carrierDefinition(id).detectionRules.every((rule) => rule.preferred);
  const departure = origin ? brandCarrierIds(name).filter((id) => carrierDefinition(id).countries?.includes(origin)
    && (!prefixed(id) || fitting.has(id))) : [];
  return [...new Set([...[...labelled, ...departure].map((id) => carrierTimezone(id)), arrival])];
}

/**
 * Lines from China whose dates are the clock of each scan's place, China's at
 * home and the place's abroad, where the catalog gives them China's zone.
 * JS Express's own feed gives the digits ParcelsApp has with China's offset
 * at its Chinese warehouse, the Netherlands' at Schiphol and the destination
 * courier's at the courier's scans; read on China's clock, a parcel's scans at
 * Schiphol came six hours early, and another's landing at JFK under five
 * hours after its flight left China. ECMS's own tracker gives the digits
 * ParcelsApp has with each facility's offset, "+09:00" at Narita: read on
 * China's clock, they came an hour after ECMS's own rows. Not every line on
 * China's clock does this: Hualei's tenants (Mayi Yinfu) and DHLink date
 * their scans abroad on Beijing time. A scan of these lines takes Beijing's
 * clock in China (with JS Express's own rule for its flights there), else
 * that of the US state or Canadian province its place names for certain
 * ("New York, United States"), else the clock of the country it names, when
 * its zones keep one at that moment (Argentina's, under several names). One
 * with no place, only a town or a country of several clocks keeps its wall
 * clock. KTD's dates do this too: it files SwiftX's hub scans at
 * SwiftX's digits under the hub's town and state, and its flight's take-off
 * in Shanghai and landing in Chicago, which China's clock put 75 minutes apart.
 * 360Lion's own tracker dates each scan with its place's offset, "-3" in
 * Argentina and "+8" at Pudong, and places it by a country or airport code
 * ("AR", "EZE", "PVG"), as ParcelsApp copies it: read on China's clock, its
 * Argentine scans came eleven hours early. Its airport code takes the
 * airport's clock.
 */
const PLACE_CLOCK_LINES = new Set(['js-express', 'ecms-express', 'ktd', '360lion', 'anjun']);
function placeClockLine(carrier: string, status: string, location: string, date: unknown): string | null {
  const china = carrier === 'js-express' ? jsExpressChinaClock(status, location) : undefined;
  if (china !== undefined) return china;
  if (carrier === '360lion' && /^[A-Z]{3}$/.test(location)) return airportTimeZone(location);
  if (inChina(location)) return 'Asia/Shanghai';
  const region = regionClock(location);
  if (region?.certain) return region.zone;
  const country = lastPlace(location);
  const wall = mislabeledWallTime(date);
  return countryTimeZone(country) ?? (wall ? sharedClockZone(countryZones(countryCode(country) ?? ''), wall) : null);
}

/**
 * The destination posts that relay a sending post's scan under the country it
 * names ("CHINA", "TAIWAN"), on that post's clock, by their home country. Read
 * on Montevideo's clock, China Post's posting came eleven hours after China
 * Post's own row of it; read on Bratislava's, Chunghwa Post's came seven
 * hours after Slovak Post's own row, which states +08:00. Azerbaijan Post
 * names the country before the office ("LATVIA: LVRIXA", "LATVİYA: Latvia"),
 * as it does a town at home ("Baku: AZBAKA"): read on Baku's clock, its
 * copies of Latvian Post's scans came two hours before Latvian Post's own.
 * La Poste names the sending country ("China"): read on Paris's clock, its
 * copy of China Post's posting came seven hours after La Poste's own instant
 * (`laPosteLetterRelay` for a tracked letter's).
 * Correios Brazil names it after "Country, ": read on Brasília's clock, China
 * Post's posting came eleven hours after China Post's own row of it.
 * DHL Paket, the sending post, names the country of its arrival abroad
 * ("Portugal") on that country's wall clock, as DHL's own tracker shows it
 * (carriers/dhl): read on Berlin's clock, it came an hour before the
 * delivering partner's own scan of it.
 * HayPost names an office abroad by its postcode and IPS's name of its country
 * (`IPS_OFFICE`): read on Yerevan's clock, its copy of Russian Post's
 * acceptance came an hour before Russian Post's own row of it. Its despatch
 * from the sending post's data is on its own clock (`haypostEdiReceived`).
 * Tusass (Greenland Post) names the country of a post abroad ("Poland") at
 * that post's exchange office: read on Nuuk's clock, its copies of Poczta
 * Polska's scans came three hours after Poczta Polska's own rows of them.
 */
const RELAYING_POSTS: Readonly<Record<string, string>> = {
  azerpost: 'AZ', 'correios-br': 'BR', 'correo-uruguayo': 'UY', dhl: 'DE', haypost: 'AM', 'la-poste': 'FR', 'slovenska-posta': 'SK', tusass: 'GL',
};
// An office as HayPost names it after IPS: its postcode, then its country in ISO's style ("Netherlands (the)").
const IPS_OFFICE = /^(?:\d{3,6}\s+)?(.+?)(?:\s*\(the\))?$/i;
// Correios Brazil names the sending post's country in Portuguese after the label ParcelsApp translates
// from its "País". There a name a Brazilian town shares, which `countryCode` leaves to the town, is the country.
const CORREIOS_TOWN_COUNTRIES: ReadonlyMap<string, string> = new Map([['FRANCA', 'FR'], ['TAILANDIA', 'TH']]);

/**
 * The clock of a sending post's scan a relaying post names abroad: that
 * country's, as on its own tracker, or null when the country keeps several
 * clocks. Undefined for a scan the place does not put abroad.
 */
function relayedPostZone(carrier: string | undefined, location: string): string | null | undefined {
  const labelled = carrier === 'correios-br' ? /^Country,\s*(.+)$/i.exec(location)?.[1] : undefined;
  const shared = labelled ? CORREIOS_TOWN_COUNTRIES.get(labelled.normalize('NFD').replace(/\p{Mn}/gu, '').trim().toUpperCase()) : undefined;
  if (shared) return countryTimeZone(shared);
  const named = relayedCountry(carrier, location);
  return named ? countryTimeZone(named) : undefined;
}

/** The name of the country abroad that a relaying post's scan names (`RELAYING_POSTS`), if any. */
function relayedCountry(carrier: string | undefined, location: string): string | undefined {
  const home = carrier && Object.hasOwn(RELAYING_POSTS, carrier) ? RELAYING_POSTS[carrier] : undefined;
  const place = carrier === 'haypost' ? IPS_OFFICE.exec(location.trim())?.[1] ?? location : location;
  const named = home ? [lastPlace(place), ...place.split(':')].find((part) => countryCode(part)) : undefined;
  return named && countryCode(named) !== home ? named : undefined;
}

/**
 * Whether a Russian Post row is the US post's copy of a scan in Russia, in USPS's words with the
 * country after them (`foreignEvent`): "Acceptance, RUSSIAN FEDERATION" at the accepting town,
 * "Processed Through Facility, MOSKVA EXAMPLE, RUSSIAN FEDERATION". Russian Post's own rows have
 * Moscow time's digits wherever they were (`RUSSIAN_POST_SUMMARY`), but these copies have the
 * scanning office's: an acceptance in a town on UTC+5 came at Russian Post's own minute there, and
 * read on Moscow's clock two hours late.
 */
function russianPostCopy(carrier: string | undefined, status: string): boolean {
  return carrier === 'russian-post' && foreignEvent(status)?.country === 'RU';
}

/**
 * The clock of the US post's copy of a scan in Russia (`russianPostCopy`), which keeps several: that
 * of a town its place names in Moscow's or Kaliningrad's zone, else null for its wall clock. The
 * gazetteer gives other Russian towns the zone of the nearest zone city, which puts Kazan on
 * Ulyanovsk's clock and Surgut on Omsk's. Its place is its location, or the words between USPS's and
 * the country.
 */
const RUSSIAN_PLACED_ZONES = new Set(['Europe/Moscow', 'Europe/Kaliningrad']);
function russianPostCopyZone(location: string, status: string): string | null {
  const place = location || status.split(',').slice(1).join(',').trim();
  const found = place ? locatePlace(place, { countries: ['RU'], carriers: ['russian-post'] }) : null;
  const zone = found?.country === 'RU' && found.precision === 'city' ? placeTimeZone(found) : null;
  return zone && RUSSIAN_PLACED_ZONES.has(zone) ? zone : null;
}

/**
 * Russian Post's export (operation 33, "International processing" in ParcelsApp's English), which
 * Russian Post lists a second time rounded to the minute on UTC's wall clock (carriers/russian-post).
 * ParcelsApp's "International processing: Transferred to carrier" has that copy's digits: read on
 * Moscow's clock it came three hours before Russian Post's own row of the export.
 */
const RUSSIAN_POST_EXPORT = /^(?:international processing:\s*\S.*|released from russia)$/i;

/**
 * The clock of a Russian office Cainiao names by its postcode alone ("Ru, 101000"), where its region keeps
 * Moscow's or Kaliningrad's: postcodes from 1, 2 and 3, central, north-western and southern Russia, and
 * Kaliningrad's oblast (236 to 238). The others, from the Volga eastwards, are left to the steps.
 */
function cainiaoRussianOfficeZone(location: string): string | undefined {
  const postcode = /^ru,\s*(\d{6})$/i.exec(location)?.[1];
  if (!postcode) return undefined;
  if (/^23[678]/.test(postcode)) return 'Europe/Kaliningrad';
  return /^[123]/.test(postcode) ? 'Europe/Moscow' : undefined;
}
function russianPostExportCopy(carrier: string | undefined, status: string, date: unknown): boolean {
  return carrier === 'russian-post' && RUSSIAN_POST_EXPORT.test(status.trim())
    && /T\d{2}:\d{2}(?::00(?:\.0+)?)?$/.test(mislabeledWallTime(date) ?? '');
}


/**
 * The zone a scan's carrier gives it wherever it was: null for a date that is
 * its instant, and undefined for a scan its place dates (`siteZone`) or only a
 * guess does (`guessedZone`).
 */
/**
 * The dates to the second of PostNL's UTC stamps in a reply: customs', and the acceptance and bagging stamps that keep
 * their seconds. Cainiao gives such a stamp's UTC digits: its arrival in the transit country at 07:53:24 was PostNL's
 * acceptance at 07:53:24Z.
 */
function postnlUtcStampDates(payload: Record<string, unknown>): Set<string> {
  return new Set((Array.isArray(payload.states) ? payload.states : []).flatMap((raw: unknown) => {
    if (!isRecord(raw) || typeof raw.status !== 'string' || typeof raw.date !== 'string') return [];
    const name = stateCarrierName(payload, raw);
    const status = raw.status.trim();
    return typeof name === 'string' && carrierIdFromName(name) === 'spring-gds' && /T\d{2}:\d{2}:(?!00)\d{2}/.test(raw.date)
      && (POSTNL_CUSTOMS_STAMP.test(status) || POSTNL_ACCEPTANCE_STAMP.test(status)) ? [raw.date.slice(0, 19)] : [];
  }));
}
/** Whether a state is Cainiao's copy of one of PostNL's UTC stamps in the reply (`postnlUtcStampDates`): its date is the instant. */
function postnlStampCopy(payload: Record<string, unknown>, name: unknown, date: unknown): boolean {
  return typeof name === 'string' && /^cainiao\b/i.test(name.trim()) && typeof date === 'string'
    && /T\d{2}:\d{2}:(?!00)\d{2}/.test(date) && postnlUtcStampDates(payload).has(date.slice(0, 19));
}

function carrierClock(payload: Record<string, unknown>, state: Record<string, unknown>, number: string, status = '',
  destination: string | null = null): string | null | undefined {
  const name = stateCarrierName(payload, state);
  const key = nameKey(name);
  const carrier = typeof name === 'string' ? carrierIdFromName(name) : undefined;
  if (carrier === 'tnt' && /^\d{9}$/.test(number)) return null;
  if (postnlStampCopy(payload, name, state.date)) return null;
  if (typeof name === 'string' && ASENDIA_USA.test(name.trim())) return null;
  if (uspsLabelRow(name, status)) return null;
  // ePost Global's feed, which ParcelsApp files under EasyShip, as ePost Global's own tracker reads it.
  const epost = key === 'easyship' ? epostGlobalCopyZone(status, feedWordings(payload)) : undefined;
  if (epost !== undefined) return epost;
  if (carrier === 'paack' || carrier === 'vinted-go' || carrier === 'austrian-post' || carrier === 'straightship'
    || ownOffset(name, state.date, scanLocation(name, state.location))) return null;
  // FAR's tracker states each scan's offset, the origin's in China and the last-mile carrier's
  // abroad; ParcelsApp keeps the digits alone, so its copies keep their wall clock.
  if (carrier === 'far-international') return null;
  // Shouwu's dates are the epoch it stores (`traceTime`), in UTC and without a place: its own
  // tracker dates its rows in China and Hong Kong at the same instants to the second.
  if (carrier === 'shouwu') return null;
  // PostNL's scans in Britain have their UTC instants: FIC shows the same scans on Dutch time. Its scans
  // in another country are that country's wall clock, as in PostNL's own feed. In countries with several
  // clocks the city or region dates the scan.
  // So do its customs stamps, whose own feed states a real UTC instant to the fraction of a second (carriers/spring-gds):
  // read on Dutch time, the clearance came an hour before Cainiao's copy of it, stated +01:00.
  if (carrier === 'spring-gds' && POSTNL_CUSTOMS_STAMP.test(status.trim())) return null;
  // And so do its acceptance and bagging stamps that keep their seconds: read on Dutch time, they came an hour
  // before PostNL's own UTC stamps of them. Those dated to the minute are on the local clock.
  if (carrier === 'spring-gds' && POSTNL_ACCEPTANCE_STAMP.test(status.trim())
    && /T\d{2}:\d{2}:(?!00)\d{2}/.test(typeof state.date === 'string' ? state.date : '')) return null;
  // And so do its label's creation and its processing record when they name no place, which its own feed keeps on UTC:
  // read on Dutch time, the label came an hour before PostNL's own record of it.
  if (carrier === 'spring-gds' && POSTNL_UTC_RECORD.test(status.trim()) && !scanLocation(name, state.location)) return null;
  const postnlPlace = carrier === 'spring-gds' ? lastPlace(scanLocation(name, state.location)) : undefined;
  const postnlCountry = countryCode(postnlPlace);
  if (postnlCountry === 'GB') return null;
  if (postnlCountry && hasSeveralClocks(postnlCountry)) return undefined;
  if (postnlCountry && postnlCountry !== 'NL') {
    const zone = countryTimeZone(postnlPlace);
    if (zone) return zone;
  }
  if (key === 'sunyousytrack' && SUNYOU_DESTINATION_LEG.test(status.trim())) return countryTimeZone(destination) ?? undefined;
  if (carrier === 'imile') {
    const country = countryCode(destination);
    return IMILE_FORWARDER_COPY.test(status.trim()) ? 'Asia/Shanghai' : country ? imileCountryClock(country) : null;
  }
  if (carrier === 'four-px' && (IMILE_FORWARDER_COPY.test(status.trim()) || FOUR_PX_IMILE_HANDOVER.test(status.trim()))) return 'Asia/Shanghai';
  if (carrier === 'mailamericas' && MAILAMERICAS_DESTINATION_CUSTOMS.test(status.trim())) {
    return MAILAMERICAS_DESTINATION_ZONES[countryCode(destination) ?? ''] ?? undefined;
  }
  if (carrier === 'china-post' && CHINA_POST_OWN_LINE_ABROAD.test(status.trim())) return CHINA_POST_ZONE;
  if (carrier === 'china-post' && chinaPostAbroad(scanLocation(name, state.location), status, destination)) return countryTimeZone(destination);
  // Cainiao's copies of Speedaf's scans keep Speedaf's digits, its arrival at the linehaul office too.
  if (carrier === 'speedaf' || (key === 'cainiao' && speedafDeparture(payload))) return speedafZone(payload, state.date, destination);
  // A SwiftX label keeps its own clock, and a listed SwiftX site dates its scans (`siteZone`), as do DHLink's relays of them.
  if (carrier === 'dhlink' && swiftxRelayed(number, destination)) {
    if (usStateClock(scanLocation(name, state.location))) return undefined;
    if (SWIFTX_LABEL.test(status.trim()) && soleDhlinkLabel(payload)) return SWIFTX_LABEL_CLOCK;
  }
  if (carrier === 'swiftx' && SWIFTX_LABEL.test(status.trim())) return SWIFTX_LABEL_CLOCK;
  if (carrier === 'swiftx' && swiftxSiteZone(payload, state, scanLocation(name, state.location))) return undefined;
  if (carrier === 'muser' && muserTownZone(scanLocation(name, state.location), destination)) return undefined;
  if (ROYAL_MAIL_NAMES.has(key) && royalMailRelay(scanLocation(name, state.location), status, destination)) return royalMailRelayClock(mislabeledWallTime(state.date) ?? '');
  if (key === '1st') {
    const location = scanLocation(name, state.location);
    return !location || firstLineInChina(location) ? FIRST_LINE_CHINA_ZONE : undefined;
  }
  // Croatia Post relays a post abroad on that facility's clock, as its own tracker does. A scan
  // without an office can be that post's too, so it keeps its wall clock, as Hrvatska pošta's adapter reads it.
  if (carrier === 'hrvatska-posta' && !scanLocation(name, state.location)) return null;
  const abroad = carrier === 'hrvatska-posta' ? hrvatskaPostaForeignZone(scanLocation(name, state.location)) : undefined;
  if (abroad !== undefined) return abroad;
  // Correos relays an origin post's scans on an item from abroad on that post's clock, or keeps their wall clock (null).
  const sent = carrier === 'correos-spain' ? correosOriginZone(number, { wording: status }) : undefined;
  if (sent !== undefined) return sent;
  // HayPost dates the despatch it has from the sending post's data on its own clock, as its tracker does.
  if (carrier === 'haypost' && haypostEdiReceived(status)) return HAYPOST_ZONE;
  const relayed = relayedPostZone(carrier, scanLocation(name, state.location));
  if (relayed !== undefined) return relayed;
  if (carrier && PLACE_CLOCK_LINES.has(carrier)) return placeClockLine(carrier, status, scanLocation(name, state.location), state.date);
  // Juxi Express relays the scans of the carrier that delivers abroad at the facility's wall clock: its
  // place's clock, or null for its wall clock in a country of several. Its own rows are Beijing's.
  const juxi = carrier === 'juxi-express' ? juxiExpressAbroadZone(scanLocation(name, state.location), status, destination) : undefined;
  if (juxi !== undefined) return juxi;
  // SXW Express copies the rows of its partner and of the carrier delivering abroad at their place's wall clock.
  const sxw = carrier === 'sxw-express' ? sxwAbroadZone(scanLocation(name, state.location), destination) : undefined;
  if (sxw !== undefined) return sxw;
  // Joom Logistics relays the scans of the lines, posts and couriers that carry its parcels at their place's wall clock,
  // as its own tracker gives them (carriers/joom-logistics), and ParcelsApp files them under Joom's name, whose catalog
  // zone is Hong Kong's: a clearance at Liège came seven hours before YunExpress's own row of it. Its scans placed
  // outside China and Hong Kong take their place's clock (`siteZone`); the others keep Hong Kong's.
  if (carrier === 'joom-logistics' && placedOutsideChina(scanLocation(name, state.location))) return undefined;
  // Posta Shqiptare's relays of a foreign post's scans, under that post's country ("Finland"), run
  // hours ahead of the foreign post's own clock by an amount that differs between countries: they
  // keep their wall clock, as Posta Shqiptare's own tracker leaves them.
  if (carrier === 'posta-shqiptare' && (countryCode(lastPlace(scanLocation(name, state.location))) ?? 'AL') !== 'AL') return null;
  // Russian Post's export copy is UTC's wall clock, its instant, and the US post's copy of a scan in Russia is
  // on its office's clock (`siteZone`). Its own rows keep Moscow's, the catalog's.
  if (russianPostExportCopy(carrier, status, state.date)) return null;
  if (russianPostCopy(carrier, status)) return undefined;
  // Cainiao relays Russian Post's scans in Russian under the office's postcode, at the digits of Russian Post's own
  // rows: read under the UTC label, an arrival in Moscow's zone came after its own departure and a customs scan three
  // hours after Russian Post's row of it.
  const russianOffice = key === 'cainiao' ? cainiaoRussianOfficeZone(scanLocation(name, state.location)) : undefined;
  if (russianOffice) return russianOffice;
  if (Object.hasOwn(HOME_CLOCKS, key)) return HOME_CLOCKS[key]!;
  // International Bridge's rows are instants under ParcelsApp's UTC label, wherever its place: on a parcel
  // USPS delivered, its receipt and departure at a facility came at the minutes USPS states for the same
  // scans with the facility's offset. Read on its Utah base's clock, the catalog's, they came 7 hours late.
  if (carrier === 'international-bridge') return 'UTC';
  if (carrier === 'correios-br') return CORREIOS_BRAZIL_CLOCK;
  if (carrier === 'spx-br') return SHOPEE_BRAZIL_CLOCK;
  // SEKO's rows of an OmniParcel parcel have the digits of OmniParcel's tracker on its default clock, a fixed +10:00,
  // wherever the scan was: read on SEKO's Chicago clock, the catalog's, a parcel's scans in Canada came 16 hours after
  // the tracker's UTC instants of them.
  if (carrier === 'seko' && OMNIPARCEL_NUMBER.test(number.toUpperCase())) return OMNIPARCEL_DEFAULT_CLOCK;
  if (carrier === 'ctt-express') return scanLocation(name, state.location) ? CTT_EXPRESS_CLOCK : null;
  // A home clock stays a guess that a location abroad rules out, even when
  // the catalog gives the network that zone (GEODIS Poland for "Pekaes").
  // CTT's copies take the clock its offices of exchange give (`cttZone`).
  const zone = carrier && carrier !== 'ctt' && !Object.hasOwn(HOME_COUNTRIES, key) ? carrierTimezone(carrier) : 'UTC';
  // A country-qualified routing name can identify a branch rather than the
  // scan location. Keep its clock as a guess even when the alias is catalogued.
  return zone !== 'UTC' && !(typeof name === 'string' && carrierNameCountryZone(name)) ? zone : undefined;
}

/** Whether a scan's place is found outside mainland China, Hong Kong and Macau. */
function placedOutsideChina(location: string): boolean {
  const country = location.trim() ? locatePlace(location)?.country : undefined;
  return country !== undefined && !['CN', 'HK', 'MO'].includes(country);
}

// Countries whose states or provinces the steps read, where a town alone can be hours from the main clock.
const REGIONAL_CLOCKS = new Set(['AU', 'CA', 'US']);

/**
 * The clock of a postal feed's scan that its place puts only in a country of
 * several clocks ("CURITIBA, Brazil", "SANTIAGO EXAMPLE, Chile"): the one most
 * of the country's people live on. UPU's and EMS's dates are the office's wall
 * clock under a UTC label: Correos Chile dates its posting and Correios Brazil
 * its arrival in Curitiba at the same digits, three hours later as instants.
 * A state or province's code ("EXAMPLE CITY, MN") is no country here.
 */
function postalCountryZone(name: unknown, location: string): string | null {
  const country = countryCode(lastPlace(location));
  return POSTAL_FEEDS.has(nameKey(name)) && country && hasSeveralClocks(country) && !REGIONAL_CLOCKS.has(country) && !regionClock(location)
    ? mainZone(country) : null;
}

// A UPU office code (IMPC): two letters for its country, three for its place and one more.
const POSTAL_OFFICE = /^([A-Z]{2})[A-Z]{3}[A-Z0-9]$/;

/**
 * Whether a postal feed's scan is placed only by the code of an office in the
 * destination. UPU's copies there have the destination post's digits under a
 * UTC label: 4-72 dates the delivery UPU copies at such an office at the same
 * digits, and read as UTC they came hours off China Post's copies of the same
 * scans. They keep their wall clock for the places step to date, which reads
 * a town's name first: "MADRID" is no Moroccan office. EMS's are wall clocks
 * already (`knownClock`).
 */
function destinationOffice(name: unknown, location: string, destination: string | null): boolean {
  return POSTAL_FEEDS.has(nameKey(name)) && destination !== null && POSTAL_OFFICE.exec(location)?.[1] === destination;
}

/**
 * Muser's copy of the delivering network's scan, placed as Muser's own tracker places it (carriers/muser): ParcelsApp
 * keeps the town and ZIP Code that follow the wording past a run of spaces, which become the place, in the ZIP Code's
 * state on a parcel to the US.
 */
function muserPlacedRow(payload: Record<string, unknown>, raw: Record<string, unknown>, destination: string | null): Record<string, unknown> {
  const name = stateCarrierName(payload, raw);
  if (typeof name !== 'string' || carrierIdFromName(name) !== 'muser' || scanLocation(name, raw.location)) return raw;
  const placed = muserTrailingPlace(typeof raw.status === 'string' ? raw.status : '');
  return placed ? { ...raw, status: placed.wording, location: muserTown(placed.place, destination) } : raw;
}

/**
 * That scan's town clock in the US. Muser's tracker states China's offset on it, at the town's wall clock, and
 * ParcelsApp has those digits: read on Muser's Chinese clock, a delivery round went out thirteen hours before
 * Muser's own row of it.
 */
function muserTownZone(location: string, destination: string | null): string | null {
  const town = destination === 'US' ? /^(.+), ([A-Z]{2})$/.exec(location) : null;
  return town ? splitRegionTownZone('US', town[2]!, town[1]!) ?? usStateTimeZone(town[2]!) : null;
}

/**
 * The zone a scan's place gives it: null for a wall clock no rule can place (a DHL
 * Express facility the rule cannot place, the US post's copy of a scan in Russia at a
 * place outside Moscow's and Kaliningrad's zones), and undefined for a scan only a guess can place (`guessedZone`).
 * China Post's scans that no place dates, with none or one the steps cannot tell
 * ("Example Town ENG GB AB1"), are on its own clock, Beijing's: 17TRACK's
 * "+08:00" copies of its airline handovers and of such scans have their digits.
 */
function siteZone(payload: Record<string, unknown>, state: Record<string, unknown>, number: string, inNorthAmerica = false,
  status = '', destination: string | null = null, distrusted: ReadonlySet<string> = NO_CODES): string | null | undefined {
  const name = stateCarrierName(payload, state);
  const key = nameKey(name);
  const carrier = typeof name === 'string' ? carrierIdFromName(name) : undefined;
  const location = scanLocation(name, state.location);
  if (russianPostCopy(carrier, status)) return russianPostCopyZone(location, status);
  if (carrier === 'ctt') return cttZone(payload, location, state.date, number, destination);
  if (carrier === 'swiftx') return swiftxSiteZone(payload, state, location) ?? undefined;
  const muser = carrier === 'muser' ? muserTownZone(location, destination) : null;
  if (muser) return muser;
  const relayed = carrier === 'dhlink' && swiftxRelayed(number, destination) ? usStateClock(location) : null;
  if (relayed) return relayed;
  if (carrier === 'spring-gds') {
    const country = countryCode(lastPlace(location));
    if (country && hasSeveralClocks(country)) {
      const found = locatePlace(location, { countries: [country] });
      if (found?.country === country && (found.precision === 'city' || found.region)) return placeTimeZone(found);
      return regionScanZone(name, location, inNorthAmerica, distrusted)?.zone ?? null;
    }
  }
  // A facility's clock, whatever the label: no other step applies to it.
  if (relaysFacilityClock(name)) return facilityZone(location);
  if (carrier === 'china-post' && inChina(location)) return CHINA_POST_ZONE;
  if (carrier === 'emirates-post' && UAE_PLACE.test(location)) return EMIRATES_POST_ZONE;
  const regional = key === 'yunexpress' ? yunExpressRegionZone(location, inNorthAmerica, distrusted) : null;
  if (regional) return regional;
  const place = (key === 'yunexpress' ? spacedCountry(location) : null) ?? lastPlace(location);
  // A state or province the town confirms beats the country its code also
  // names ("Chicago, IL"); a merely possible one comes after ("Koeln, DE").
  // Australia Post's "WA" and "NT" are Australian states, not Washington or the Northwest Territories.
  const australiaPost = carrier === 'australia-post' ? australiaPostZone(location) : null;
  if (australiaPost) return australiaPost;
  const region = regionScanZone(name, location, inNorthAmerica, distrusted);
  if (region?.certain) return region.zone;
  // A code of the reply's own origin or destination that the town, a ZIP code or the country does not place in
  // North America is that end's: "Casablanca, MA" on a parcel bound for Morocco, and Australia's "WA" and "NT".
  const own = distrusted.size ? regionClock(location, distrusted) : null;
  const end = own?.distrusted && !own.certain ? own.distrusted : null;
  const ended = !end ? null : end === 'WA' || end === 'NT' ? australianZone(location, false) : hasSeveralClocks(end) ? null : mainZone(end);
  if (ended) return ended;
  // So is a state and its four-digit postcode at the reply's Australian end: "EXAMPLE TOWN WA 6000".
  const addressed = distrusted.has('WA') ? AUSTRALIAN_ADDRESS.exec(location)?.[1] : undefined;
  if (addressed) return AUSTRALIAN_STATE_ZONES.get(addressed)!;
  // A posting's capital names its office, not the scan's state (`postingOffice`).
  const capitals = !postalPosting(name, status);
  // A town of the state or province whose code a country shares is not in
  // that country: "Denver, CO" is not in Colombia, whoever scanned it.
  const located = regionClock(location, distrusted)?.certain ? null
    : countryTimeZone(place) ?? (countryCode(place) === 'AU' ? australianZone(location, capitals) : null);
  if (located) return located;
  if (region) return region.zone;
  const postal = postalCountryZone(name, location);
  if (postal) return postal;
  if (POSTAL_FEEDS.has(key) && POSTAL_ORIGIN_LEG.test(status.trim())) {
    const origin = replyOrigin(payload, number);
    return countryTimeZone(origin) ?? (origin === 'AU' ? australianZone(location, capitals) : null) ?? undefined;
  }
  // A ZIP Code alone, on an item bound for the US, is the delivery office's, and UPU
  // dates its scans there on that office's clock: China Post's copy of the delivery
  // has the digits of UPU's, on the clock its place in the US gives it.
  const zip = POSTAL_FEEDS.has(key) && destination === 'US' ? usStateTimeZone(usZipState(location)) : null;
  if (zip) return zip;
  return carrier === 'china-post' ? CHINA_POST_ZONE : undefined;
}

/**
 * Whether a scan names no network that the catalog or the tables above know:
 * no carrier, or a name new to both ("Example Parcel Co"). Its date is still
 * ParcelsApp's wall clock under a UTC label, and nothing says on which clock,
 * so one that no step places has no instant.
 */
function unknownNetwork(name: unknown): boolean {
  if (typeof name !== 'string' || !name.trim()) return true;
  const key = nameKey(name);
  return !isKnownCarrierName(name) && !isCarrierFeedName(name) && !Object.hasOwn(HOME_CLOCKS, key) && !Object.hasOwn(HOME_COUNTRIES, key)
    && ![WALL_CLOCKS, LOCAL_CLOCK_CARRIERS, POSTAL_FEEDS].some((keys) => keys.has(key)) && !KNOWN_CLOCKS.has(key);
}

/**
 * Whether a scan names a bare brand all of whose catalog networks keep a local
 * clock ("DPD Group", "GLS"; `brandTimeZones`). Its date is the wall clock of
 * whichever network scanned it under a UTC label: DPD Germany's own tracker
 * dates a "DPD Group" handover two hours before ParcelsApp's label. So one
 * that no step places, where the networks keep different clocks or the scan's
 * location may be a network outside the catalog, has no instant. A brand with
 * a network on UTC (DHL's eCommerce network) keeps its label.
 */
function localClockBrand(name: unknown): boolean {
  return typeof name === 'string' && brandTimeZones(name).length > 0;
}

function guessedZone(payload: Record<string, unknown>, state: Record<string, unknown>, fallback: string | null, number: string,
  destination: string | null = null, origin: string | null = null, filed: string | null = null): string | null {
  const name = stateCarrierName(payload, state);
  const key = nameKey(name);
  const carrier = typeof name === 'string' ? carrierIdFromName(name) : undefined;
  const location = scanLocation(name, state.location);
  // The zones below only guess where the scan was. A location in another
  // country, one with several clocks or none listed ("Example City, CA,
  // United States", "Example City, South Africa"), rules a guess out, and the
  // scan keeps its labeled instant, or its wall clock (`unknownNetwork`).
  const guess = (candidate: string | null) => fitsPlace(candidate, location);
  if (typeof name !== 'string') return guess(fallback);
  const nameZone = carrierNameCountryZone(name);
  // Yanwen files its own rows without a place. One with a place no step located is its copy of the
  // delivering post's scan at the facility's wall clock: Poczta Polska's own words ("Doręczona") at
  // a Polish office had the digits of Poland Post's scans, stated +01:00. It takes the destination's
  // clock where that keeps one.
  const relayed = key === 'yanwenlogistics' && location ? countryTimeZone(countryCode(destination)) : null;
  const named = guess(relayed || (nameZone && (filedNetworkZone(carrier, filed) ?? numberNetworkZone(carrier, number))) || nameZone
    || (HOME_COUNTRIES[key] ?? null));
  if (named) return named;
  // A location with no single-clock country ("Toronto, ON", "Chicago, US")
  // can be a network of the brand outside the catalog, on another clock.
  const brand = location ? [] : brandTimeZones(name);
  const wall = brand.length ? mislabeledWallTime(state.date) : null;
  return (wall ? sharedClockZone(brand, wall) ?? sharedClockZone(brandNetworkZones(payload, name, number, destination, origin), wall) : null)
    ?? guess(fallback);
}

/**
 * How to read a state: the zone its carrier or place gives (with the guesses of steps 3 to 5
 * for a network that is not a wall clock), whether its state or province
 * gave it, and for a wall-clock scan, routing's zone and any known clock,
 * which `wallClockZones` falls back on.
 */
function readState(payload: Record<string, unknown>, raw: Record<string, unknown>, status: string, fallback: string | null, number: string,
  inNorthAmerica = false, destination: string | null = null, origin: string | null = null, distrusted: ReadonlySet<string> = NO_CODES,
  filed: string | null = null) {
  const name = stateCarrierName(payload, raw);
  const location = scanLocation(name, raw.location);
  const offset = ownOffset(name, raw.date, location);
  const wallClock = WALL_CLOCKS.has(nameKey(name)) && !offset && !uspsLabelRow(name, status) && !postnlStampCopy(payload, name, raw.date);
  const partner = royalMailPartnerRelay(payload, name, raw.date, raw.location);
  const relay = polandPostRelay(name, raw.date, location, number, destination) ?? laPosteLetterRelay(name, raw.date, location, number)
    ?? correosDeMexicoRelay(name, raw.date, location, origin, destination) ?? partner;
  const pitneyBowes = relay ? undefined : pitneyBowesClock(payload, raw, status, destination);
  // A Royal Mail partner's row that nothing places keeps its wall clock, not Royal Mail's home clock.
  const own = partner !== null && relay === partner ? partner.zone
    : relay?.zone ?? (pitneyBowes ? pitneyBowes.zone : carrierClock(payload, raw, number, status, destination));
  // iMile's page writes every scan on the recipient country's clock, wherever it happened, and
  // ParcelsApp has its digits; read on iMile's catalog zone they came out early. A destination
  // of one zone places them, and without one they keep their wall clock. So do China Post's
  // copies of the destination post's scans (`chinaPostAbroad`), Croatia Post's scan without an
  // office or at a facility abroad whose office code names no single clock, Correos's and a relaying
  // post's copies of an origin post's scan from a country of several clocks, Juxi Express's copy of a
  // local carrier's scan there (`juxiExpressAbroadZone`), a scan of a
  // line on its place's clock that its place does not date (`PLACE_CLOCK_LINES`), and Pitney
  // Bowes's relay of a destination post's scan on a parcel bound for no single clock (`pitneyBowesClock`).
  const ownCarrier = typeof name === 'string' ? carrierIdFromName(name) ?? '' : '';
  const unplacedWall = own === null && !offset && (pitneyBowes?.zone === null || (partner !== null && relay === partner)
    || ['imile', 'china-post', 'hrvatska-posta', 'correos-spain', 'far-international', 'posta-shqiptare', 'juxi-express', 'sxw-express'].includes(ownCarrier) || Object.hasOwn(RELAYING_POSTS, ownCarrier)
    || PLACE_CLOCK_LINES.has(ownCarrier) || (nameKey(name) === 'easyship' && epostGlobalCopyZone(status, feedWordings(payload)) === null));
  const sited = own === undefined ? siteZone(payload, raw, number, inNorthAmerica, status, destination, distrusted) : undefined;
  const placed = own !== undefined ? own : sited;
  // A posting that only its office's capital places borrows first (`postingOffice`).
  const office = placed === undefined ? postingOffice(name, status, location, replyOrigin(payload, number)) : null;
  const destinationCode = placed === undefined && !wallClock && destinationOffice(name, location, destination);
  const zone = placed !== undefined ? placed
    : wallClock || office || destinationCode ? null : guessedZone(payload, raw, fallback, number, destination, origin, filed);
  const known = wallClock ? knownClock(name, status, destination, origin) : null;
  // A local clock that nothing places, in the US or Canada alone ("US 12345").
  const country = countryCode(lastPlace(location));
  const nationwide = placed === undefined && zone === null && LOCAL_CLOCK_CARRIERS.has(nameKey(name)) && (country === 'US' || country === 'CA');
  return { name, date: relay?.date ?? raw.date, zone, placed: placed ?? null, sited: sited ?? null, guessed: placed === undefined && !wallClock,
    offset, location, wallClock, nationwide, office,
    // How the zone was chosen (`zoneBasis`), and whether the date is an instant the carrier stated.
    basis: partner !== null && relay === partner ? partner.basis : own === undefined && sited !== undefined ? 'place' as const : 'carrier' as const,
    instant: own === null,
    local: zone !== null && zone === regionScanZone(name, location, inNorthAmerica, distrusted)?.zone,
    fallback: wallClock || office ? fitsPlace(fallback, location) : null, known: known?.zone ?? null, arrival: known?.country ?? null,
    // With no zone, a scan whose label nothing vouches for keeps its wall clock, as does one on a clock its place cannot
    // tell (`siteZone`) or at a port of entry no row names (`knownClock`).
    wallOnly: unplacedWall || sited === null || destinationCode || unknownNetwork(name) || localClockBrand(name) || militaryPostOffice(location)
      || known?.port === true };
}

type ZoneStep = 'carrier' | 'place' | 'copy' | 'borrowed' | 'routing' | 'known' | 'labeled';

/**
 * How a scan's zone was chosen, as a carrier's deduced clock says it
 * (`time_zone_basis`): its place, a neighbouring or copied scan, the
 * destination's clock, or its carrier's; `label` for a date read on
 * ParcelsApp's UTC label because nothing placed it. A date its carrier states
 * as an instant, or with an offset, has none.
 */
function zoneBasis(entry: { basis: 'place' | 'carrier' | 'neighbour'; instant: boolean; offset: unknown; office: string | null; arrival: string | null; zone: string | null },
  step: ZoneStep, zone: string | null): string | undefined {
  if (!zone) return entry.instant || entry.offset ? undefined : 'label';
  if (step === 'copy' || step === 'borrowed') return 'neighbour';
  if (step === 'known') return entry.arrival ? 'destination' : 'carrier';
  if (step === 'routing') return 'carrier';
  return step === 'place' && !entry.zone && entry.office ? 'place' : entry.basis;
}

/**
 * The zone of each scan. One from a network that is not a wall clock keeps
 * the one it has. A wall-clock scan takes, in order:
 * 1. the zone of its place;
 * 2. that of another carrier's placed scan with the same digits and wording,
 *    which it copies (`copy`);
 * 3. as a guess, that of the scan of its network just before it by wall
 *    clock that steps 1 and 2 place, else of the one just after it; for a
 *    scan in the destination, only of one placed there;
 * 4. its known clock (`KNOWN_CLOCKS`): a fixed one, for a scan that skips
 *    step 3, or the destination's single clock;
 * 5. the zone routing passes for the parcel, which is another network's for
 *    a parcel filed under it: Lagos's for Cainiao's copies under Speedaf;
 * 6. none: it keeps ParcelsApp's label, as it did before these steps, the
 *    last guess.
 * A zone the scan's location rules out is skipped ("USA" takes no Canadian
 * zone). Step 3 holds when the scan happens where its neighbours do, and is
 * hours off when it does not. Checked on 2026-10-10 against the carriers'
 * own clocks: Canada Post's first scan and one in Chicago took the right
 * zone, and its last two, in Montana, the Chicago hub's, an hour off USPS's.
 * SpeedPAK's four took the right one, and a Chinese system event the US one,
 * 14 hours off. USPS's "In Transit to Next Facility" was not checked: no
 * source gives its clock. 4PX's scans between the departing flight and the
 * first US scan took China's until they were known to be in the destination
 * (2026-10-11); its US scans with no state take the right zone, or one an
 * hour off when the parcel changed zones around them.
 *
 * A scan of a carrier with local clocks (`LOCAL_CLOCK_CARRIERS`) that its
 * location places only in the US or Canada borrows as in step 3, from a scan
 * of its network that a place gives a zone, and otherwise keeps its label,
 * except UPS's and FedEx's (`UNLOCATED_LOCAL_CLOCKS`), which are wall times.
 * FedEx's "Shipment information sent to FedEx" under the shipper's ZIP code
 * took the zone of the pickup's state after it, as FedEx's own page dates it
 * (checked 2026-10-11).
 *
 * A postal feed's posting in Australia that only its office's capital places
 * (`postingOffice`) borrows as in step 3 too, and takes that capital's clock
 * after any known clock, before routing's.
 */
function wallClockZones(entries: readonly {
  name: unknown; date: unknown; location: string; zone: string | null; placed: string | null; copy: string | undefined;
  wallClock: boolean; nationwide: boolean; office: string | null; fallback: string | null; known: string | null; arrival: string | null;
}[]): { zone: string | null; step: ZoneStep }[] {
  const found = entries.map((entry): { zone: string | null; step: ZoneStep } | null => !entry.wallClock
    ? entry.zone || !(entry.nationwide || entry.office) ? { zone: entry.zone, step: 'carrier' } : null
    : entry.zone ? { zone: entry.zone, step: 'place' } : entry.copy ? { zone: entry.copy, step: 'copy' } : null);
  const walls = entries.map((entry) => mislabeledWallTime(entry.date) ?? '');
  return entries.map((entry, index) => {
    const own = found[index];
    if (own) return own;
    const key = nameKey(entry.name);
    const wall = walls[index]!;
    let before: { wall: string; zone: string } | undefined;
    let after: { wall: string; zone: string } | undefined;
    if (!entry.known || entry.arrival) {
      entries.forEach((other, at) => {
        const zone = other.wallClock !== entry.wallClock ? null : entry.wallClock ? found[at]?.zone : other.placed;
        const near = { wall: walls[at]!, zone: zone ?? '' };
        if (!zone || nameKey(other.name) !== key || !fitsPlace(zone, entry.location, true)) return;
        if (entry.arrival && (timeZoneCountry(zone) ?? STATE_ZONES.get(zone)) !== entry.arrival) return;
        if (near.wall <= wall) {
          if (!before || near.wall > before.wall) before = near;
        } else if (!after || near.wall < after.wall) after = near;
      });
    }
    const borrowed = (before ?? after)?.zone;
    const known = fitsPlace(entry.known, entry.location);
    return borrowed ? { zone: borrowed, step: 'borrowed' } : known ? { zone: known, step: 'known' }
      : entry.office ? { zone: entry.office, step: 'place' }
        : entry.fallback ? { zone: entry.fallback, step: 'routing' } : { zone: null, step: 'labeled' };
  });
}

/**
 * The zone of a scan that only a guess dates, or none, from another carrier's
 * scan at the same digits and place that its place dates (`siteZone`): the
 * same scan, relayed at the digits of where it happened. Saudi Post's copy of
 * a departure from Sydney, in SPL's words at its office "SYDNEY", has the
 * digits of EMS's "Departed from export office" at "Sydney". The place is the
 * location's first part, so "SYDNEY EMS, Australia" is another. Copies on
 * different clocks give none.
 */
function placeCopies(items: readonly { name: unknown; date: unknown; location: string; sited: string | null; guessed: boolean }[]): (string | null)[] {
  const site = ({ date, location }: typeof items[number]) => {
    const wall = mislabeledWallTime(date);
    const place = nameKey(location.split(',')[0]);
    return wall && place ? `${wall}|${place}` : '';
  };
  const sited = new Map<string, (readonly [string, string])[]>();
  for (const item of items) {
    const key = site(item);
    if (key && item.sited) sited.set(key, [...sited.get(key) ?? [], [nameKey(item.name), item.sited]]);
  }
  return items.map((item) => {
    const copies = item.guessed ? sited.get(site(item)) ?? [] : [];
    const zones = new Set(copies.filter(([network]) => network !== nameKey(item.name)).map(([, zone]) => zone));
    const [zone] = zones.size === 1 ? [...zones] : [];
    return zone ? fitsPlace(zone, item.location, true) : null;
  });
}

/**
 * The zone of China Post's copy of the destination post's scan that neither
 * its place nor its wording tells ("Final delivery" at a code of China Post's
 * own): that of another network's scan at the same minute whose zone is the
 * destination's, the post's own or UPU's copy of it. China Post's delivery on
 * an item to New Zealand had the minute of New Zealand Post's own delivery;
 * read on China's clock it came five hours later. China Post's own scans
 * abroad have no such twin and stay on China's clock.
 */
function chinaPostTwinZones(items: readonly { name: unknown; date: unknown; location: string }[], zones: readonly (string | null)[],
  destination: string | null): (string | null)[] {
  const minute = (date: unknown) => mislabeledWallTime(date)?.slice(0, 16) ?? '';
  const chinaPost = (name: unknown) => typeof name === 'string' && carrierIdFromName(name) === 'china-post';
  const twins = new Map<string, Set<string>>();
  items.forEach(({ name, date }, index) => {
    const zone = zones[index];
    const key = minute(date);
    if (destination && destination !== 'CN' && key && zone && !chinaPost(name) && keepsZone(destination, zone)) {
      twins.set(key, (twins.get(key) ?? new Set()).add(zone));
    }
  });
  return items.map(({ name, date, location }, index) => {
    const found = chinaPost(name) && zones[index] === CHINA_POST_ZONE && !inChina(location) ? twins.get(minute(date)) : undefined;
    return found?.size === 1 ? [...found][0]! : null;
  });
}

/**
 * The zone of a postal feed's scan on the origin post's leg (`POSTAL_ORIGIN_LEG`) that no step
 * places, from the scans at its minute that one does: a copy of it in the same words, else those
 * in the reply's origin country, when they share one zone. Their dates are the origin office's wall
 * clock. UPU's "Posting/Collection" of an item posted in Russia, which has several clocks, came at
 * the minute of Russian Post's own acceptance on Moscow's clock and, read on ParcelsApp's UTC label,
 * three hours after it. So is a relaying post's copy of a scan in the origin country that keeps its
 * wall clock (`relayedPostZone`): HayPost's of that acceptance, in the words of IPS. So is the US
 * post's copy of a scan in Russia that its place does not date (`russianPostCopy`). Only a zone the
 * origin keeps places it, and a scan placed outside the origin is not counted.
 */
function postalTwinZones(items: readonly { name: unknown; date: unknown; location: string; offset: unknown; raw: Record<string, unknown> }[],
  zones: readonly { zone: string | null; step: ZoneStep }[], origin: string | null): (string | null)[] {
  const minute = (date: unknown) => mislabeledWallTime(date)?.slice(0, 16) ?? '';
  const words = (raw: Record<string, unknown>) => relayedLabel(raw.status).trim().toLowerCase();
  const shared = (found: readonly string[]) => (new Set(found).size === 1 ? found[0]! : null);
  return items.map((item, index) => {
    const key = minute(item.date);
    const carrier = typeof item.name === 'string' ? carrierIdFromName(item.name) : undefined;
    const relayed = !POSTAL_FEEDS.has(nameKey(item.name)) && origin !== null && (countryCode(relayedCountry(carrier, item.location)) === origin
      || (origin === 'RU' && russianPostCopy(carrier, relayedLabel(item.raw.status))));
    if (zones[index]!.zone || item.offset || !key || !(relayed || (POSTAL_FEEDS.has(nameKey(item.name))
      && POSTAL_ORIGIN_LEG.test(relayedLabel(item.raw.status).trim())))) return null;
    const twins = items.flatMap((other, at) => {
      const { zone, step } = zones[at]!;
      return at !== index && zone && step !== 'labeled' && minute(other.date) === key ? [{ zone, same: words(other.raw) === words(item.raw) }] : [];
    });
    const copied = shared(twins.filter(({ same }) => same).map(({ zone }) => zone));
    const local = origin ? shared(twins.filter(({ zone }) => keepsZone(origin, zone)).map(({ zone }) => zone)) : null;
    const zone = copied ?? local;
    return relayed ? (zone && keepsZone(origin, zone) ? zone : null) : fitsPlace(zone, item.location, true);
  });
}

/**
 * The zone of YunExpress's copy of its last-mile partner's scan, which its feed relays in its own
 * words with no place, at the partner's digits to the second. YunExpress's "In Transit" came at
 * the second of GOFO's "In Transit to Next Facility", Central time digits under ParcelsApp's UTC
 * label: read as labeled, it came five hours before GOFO's own instant. It takes the zone or
 * offset of the other networks' dated scans at that second when they share one. So does its copy
 * placed only in a country of several clocks: its "Shipping Label Created" in the "United States of
 * America" had GOFO's Pacific digits, seven hours before GOFO's own instant as labeled. A second of
 * :00 can be a minute-only clock's, so it places nothing.
 */
const PARTNER_RELAYS = new Set(['yunexpress']);

/**
 * The country of a place YunExpress writes as a town, its state and the country's code with spaces
 * alone ("EXAMPLE TOWN STATE AU"), which `lastPlace` reads as one name.
 */
function spacedCountry(location: string): string | null {
  const code = /^[^,]+\s([A-Za-z]{2})$/.exec(location.trim())?.[1];
  return code ? countryCode(code) : null;
}

/**
 * The clock of YunExpress's scan at a place in a US state or a Canadian province: its feed gives
 * such a scan that place's wall clock under ParcelsApp's UTC label. It names USPS's facility on its
 * copies of USPS's scans ("EXAMPLE CITY TX DISTRIBUTION CENTER"), and a town, its state and the
 * country's code with spaces alone on its own ("EXAMPLE CITY TEXAS US"). Read on the label, its
 * copies of USPS's scans came six hours before USPS's own on Central time, and its customs
 * clearance six hours before its own tracker's at that town. The country's code is read as the
 * country's ("EXAMPLE TOWN ON CA" is in Ontario, not California), and another country's
 * (`spacedCountry`) places nothing here.
 */
function yunExpressRegionZone(location: string, inNorthAmerica: boolean, distrusted: ReadonlySet<string>): string | null {
  const spaced = spacedCountry(location);
  if (spaced && spaced !== 'US' && spaced !== 'CA') return null;
  const region = regionClock(spaced ? location.trim().replace(/\s+[A-Za-z]{2}$/, spaced === 'US' ? ', US' : ', Canada') : location, distrusted);
  return region && (region.certain || (inNorthAmerica && !region.distrusted)) ? region.zone : null;
}

/**
 * The clock of YunExpress's scans in a destination of several clocks that nothing places: the
 * flight's arrival at the country alone, a sorting with no place and its copy of the last-mile
 * carrier's receipt. Its feed gives them the digits of the clock of its scans at a town there: its
 * copy of Australia Post's receipt had Australia Post's own digits, eleven hours late as labeled.
 * Such a scan takes the zone of YunExpress's scans placed in the destination when they share one:
 * one at the country alone, or one with no place after the first of them. In the US and Canada its
 * other scans with no place are its partners' on their facilities' clocks (`relayTwinZones`), and
 * only those at the airport the flight lands at take a zone (`yunExpressAirportZones`).
 */
function yunExpressDestinationZones(items: readonly { name: unknown; date: unknown; location: string; offset: string | null | undefined; wording: string }[],
  zones: readonly { zone: string | null }[], destination: string | null): (string | null)[] {
  const none = items.map(() => null);
  if (destination === 'US' || destination === 'CA') return yunExpressAirportZones(items, zones, destination);
  if (!destination || countryTimeZone(destination)) return none;
  const yun = (name: unknown) => nameKey(name) === 'yunexpress';
  const placed = items.flatMap((item, index) => {
    const zone = zones[index]!.zone;
    return yun(item.name) && zone && (timeZoneCountry(zone) ?? STATE_ZONES.get(zone)) === destination
      ? [{ wall: mislabeledWallTime(item.date) ?? '', zone }] : [];
  });
  const shared = new Set(placed.map(({ zone }) => zone));
  if (shared.size !== 1) return none;
  const [zone] = [...shared];
  const first = placed.map(({ wall }) => wall).filter(Boolean).sort()[0] ?? '';
  return items.map((item, index) => {
    if (!yun(item.name) || item.offset || zones[index]!.zone) return null;
    const location = item.location.trim();
    const wall = mislabeledWallTime(item.date) ?? '';
    return (location ? countryCode(location) === destination : Boolean(first && wall > first)) ? zone! : null;
  });
}

// The flight's arrival, the import clearance (`YUNEXPRESS_IMPORT_CUSTOMS`), the cargo terminal's
// collection and the hand-over to the last-mile carrier: YunExpress's scans at the arrival airport.
const YUNEXPRESS_AIRPORT_LEG = /^(?:international flight has arrived|collected at cargo terminal|delivered to local carrier)$/;

/**
 * The clock of YunExpress's scans with no place at the airport its flight lands at in the US or
 * Canada: that of its import clearance placed at a town there (`yunExpressRegionZone`), when its
 * placed clearance rows share one zone. Its own adapter dates the arrival and the clearance on that
 * airport's clock. The arrival, the clearance's completion, the release, the cargo terminal's
 * collection and the hand-over to USPS came six hours early as labeled, beside its own tracker's
 * copies on its clearance town's Central time.
 */
function yunExpressAirportZones(items: readonly { name: unknown; location: string; offset: string | null | undefined; wording: string }[],
  zones: readonly { zone: string | null }[], destination: string): (string | null)[] {
  const yun = (name: unknown) => nameKey(name) === 'yunexpress';
  const words = (wording: string) => wording.replace(/\s+/g, ' ').trim().toLowerCase();
  const cleared = new Set(items.flatMap((item, index) => {
    const zone = zones[index]!.zone;
    return yun(item.name) && item.location.trim() && zone && YUNEXPRESS_IMPORT_CUSTOMS.test(words(item.wording))
      && (timeZoneCountry(zone) ?? STATE_ZONES.get(zone)) === destination ? [zone] : [];
  }));
  const [zone] = cleared.size === 1 ? [...cleared] : [];
  return items.map((item, index) => {
    const leg = YUNEXPRESS_AIRPORT_LEG.test(words(item.wording)) || YUNEXPRESS_IMPORT_CUSTOMS.test(words(item.wording));
    return zone && yun(item.name) && leg && !item.location.trim() && !item.offset && !zones[index]!.zone ? zone : null;
  });
}

/**
 * The clock of YunExpress's scans with no place on China's leg, up to the flight out: China's, or
 * Hong Kong's, when its nearest scan with a place, the older one first, is there, as YunExpress's
 * own adapter dates them (`yunExpressOriginLeg`). Its flight out came at China's digits: as labeled, it left eight
 * hours late, after the import clearance its destination's town dated.
 */
function yunExpressOriginZones(items: readonly { name: unknown; date: unknown; location: string; offset: string | null | undefined; wording: string;
  guessed: boolean }[], zones: readonly { zone: string | null; step: ZoneStep }[]): (string | null)[] {
  const rows = items.flatMap((item, index) => nameKey(item.name) === 'yunexpress' ? [{ item, index, wall: mislabeledWallTime(item.date) ?? '' }] : [])
    .sort((a, b) => (a.wall < b.wall ? 1 : a.wall > b.wall ? -1 : 0));
  const leg = yunExpressOriginLeg(rows.map(({ item }) => ({ location: item.location.trim(), wording: item.wording })));
  const found = items.map((): string | null => null);
  // A guessed zone, routing's among them, gives way: routing passes another network's for a parcel filed under it, and on
  // iMile's Dubai clock, for a parcel iMile delivers in Germany, YunExpress's export clearance came four hours after its
  // own row of it.
  rows.forEach(({ item, index }, at) => {
    const zone = zones[index]!;
    if (leg[at] && !item.offset && (!zone.zone || zone.step === 'routing' || (item.guessed && zone.step === 'carrier'))) found[index] = leg[at]!;
  });
  return found;
}

function relayTwinZones(items: readonly { name: unknown; date: unknown; location: string; offset: string | null | undefined }[],
  zones: readonly { zone: string | null; step: ZoneStep }[]): (string | null)[] {
  const second = ({ date, offset }: typeof items[number]) => {
    const wall = offset ? DateTime.fromISO(String(date).trim(), { setZone: true }).toISO({ includeOffset: false }) : mislabeledWallTime(date);
    return wall && !/:00(?:\.0+)?$/.test(wall) ? wall.slice(0, 19) : '';
  };
  const relay = (name: unknown) => PARTNER_RELAYS.has(nameKey(name));
  const twins = new Map<string, Set<string>>();
  items.forEach((item, index) => {
    const key = second(item);
    const { zone, step } = zones[index]!;
    const clock = item.offset ? `UTC${item.offset}` : step === 'labeled' ? null : zone;
    if (key && clock && !relay(item.name)) twins.set(key, (twins.get(key) ?? new Set()).add(clock));
  });
  return items.map((item, index) => {
    const place = item.location.trim();
    const found = relay(item.name) && (!place || countryCode(place)) && !item.offset && !zones[index]!.zone ? twins.get(second(item)) : undefined;
    return found?.size === 1 ? [...found][0]! : null;
  });
}

/**
 * The clock of a network that nothing places, as its copies show. A line
 * provider outside the catalog can file the same scans as the carrier that
 * relays it, at the same digits, with no place: under ParcelsApp's UTC label
 * each scan would come twice, hours apart. When every scan of a network has no
 * zone and the other carriers' copies of its scans, at the same digits and
 * wording, share one zone, that zone is the network's: its copies stay one
 * scan with theirs, and its own scans keep the same clock.
 */
function copiedNetworkZones(items: readonly { name: unknown; key: string; zone: string | null; fixed: boolean; location: string }[]): (string | null)[] {
  const zoned = new Map<string, string>();
  for (const { key, zone } of items) if (key && zone) zoned.set(key, zoned.has(key) && zoned.get(key) !== zone ? '' : zone);
  const unplaced = new Map<string, Set<string>>();
  for (const { name, key, zone, fixed } of items) {
    const network = nameKey(name);
    if (!network) continue;
    if (zone || fixed) unplaced.set(network, new Set(['']));
    else if (!unplaced.has(network)) unplaced.set(network, new Set());
    const copied = zoned.get(key);
    if (!zone && !fixed && copied !== undefined) unplaced.get(network)!.add(copied);
  }
  return items.map(({ name, zone, fixed, location }) => {
    const copies = unplaced.get(nameKey(name));
    const [clock] = copies?.size === 1 ? [...copies] : [];
    return !zone && !fixed && clock ? fitsPlace(clock, location) : null;
  });
}

const DAY_MS = 86_400_000;
const clockOf = (event: CarrierEvent): string => event.time ?? (typeof event.local_time === 'string' ? event.local_time : '');
/** An event's moment, a wall clock read as if UTC; a day alone is its start, or its end with `end`. */
function moment(event: CarrierEvent, end = false): number {
  if (event.time) return Date.parse(event.time);
  const local = clockOf(event);
  return local.length === 10 ? Date.parse(`${local}T00:00:00Z`) + (end ? DAY_MS : 0) : Date.parse(`${local}Z`);
}

/**
 * A carrier's acceptance after another carrier already moved the parcel is the
 * hand-over to it, as DPD's "parcel handed" is when it takes a cleared parcel
 * from the line carrier: the parcel moves on rather than starting over. A wall
 * clock is later only by more than a day, whatever its zone, except after a
 * dated move: an acceptance whose wall time would sort above that move, as the
 * result sorts it, is the hand-over too, so it does not stand as the parcel's
 * newest step over the move (a forwarder's "goods have been picked up from
 * warehouse" on its own clock, hours after DPD Poland's dated scans).
 */
function markHandovers(carried: readonly { event: CarrierEvent; carrier: string }[]): void {
  const moved = new Map<string, CarrierEvent>();
  for (const { event, carrier } of carried) {
    const earliest = moved.get(carrier);
    if (carrier && clockOf(event) && (event.stage === 'in_transit' || event.stage === 'customs')
      && (!earliest || moment(event) < moment(earliest))) moved.set(carrier, event);
  }
  const before = (earlier: CarrierEvent, later: CarrierEvent) => earlier.time && clockOf(later).length > 10
    ? moment(earlier) < moment(later) : moment(earlier, true) + DAY_MS < moment(later);
  for (const { event, carrier } of carried) {
    if (event.stage !== 'accepted' || !carrier || !clockOf(event)) continue;
    if ([...moved].some(([other, earlier]) => other !== carrier && before(earlier, event))) event.stage = 'in_transit';
  }
}

/**
 * YunExpress's arrival at its origin facility, when it is the first of YunExpress's scans to move
 * the parcel, is YunExpress taking the parcel in, as its own adapter reads it: a parcel its sender
 * brings to that facility has no pick-up before it.
 */
function markYunExpressIntake(carried: readonly { event: CarrierEvent; carrier: string }[]): void {
  let first: CarrierEvent | undefined;
  for (const { event, carrier } of carried) {
    const moves = carrier === 'yunexpress' && clockOf(event) && event.stage && event.stage !== 'registered' && event.stage !== 'pending';
    if (moves && (!first || moment(event) < moment(first))) first = event;
  }
  if (first?.stage === 'in_transit' && /^arrived at origin facility$/i.test(first.description?.trim() ?? '')) {
    Object.assign(first, { stage: 'accepted', stage_source: 'carrier_map' });
  }
}

const BARE_DELIVERY = /^delivered[.!]?$/i;
const MOVEMENTS: ReadonlySet<string> = new Set(['accepted', 'in_transit', 'customs', 'out_for_delivery', 'failed_attempt']);
/**
 * The deliveries, and the bare "Delivered" rows, a scan of the reply moves the parcel past more
 * than a day later. ParcelsApp words a leg's end so: SEUR's on the day it
 * handed a parcel to BRT, five days before BRT's own scans of it, and
 * MailAmericas' "Delivered by Airline" before the destination's customs. A
 * day, as the clocks of a reply's networks can stand hours apart.
 */
function passedDeliveries(events: readonly CarrierEvent[]): CarrierEvent[] {
  const moves = events.filter((event) => event.stage_source !== 'none' && MOVEMENTS.has(event.stage ?? '')).map((event) => moment(event));
  return events.filter((event) => (event.stage === 'delivered' || BARE_DELIVERY.test(event.description?.trim() ?? ''))
    && moves.some((at) => at - moment(event, true) > DAY_MS));
}

/**
 * The steps dated by their day alone (`datedOnly`) that a timed scan of
 * another network shows at the same stage that day: BRT's "FOR DELIVERY" on a
 * parcel DPD Germany delivers, whose "Parcel out for delivery" ParcelsApp has
 * at its minute. With no time, the copy has no place among the day's scans. A
 * network's own scans are not copies of its step: USPS's "In Transit to Next
 * Facility" stays beside the day's facility scans.
 */
function timedTwins(carried: readonly { event: CarrierEvent; carrier: string }[], days: ReadonlySet<CarrierEvent>): CarrierEvent[] {
  return carried.filter(({ event: day, carrier }) => days.has(day) && day.stage_source !== 'none'
    && carried.some(({ event: other, carrier: network }) => network !== carrier && !days.has(other) && other.stage === day.stage
      && other.stage_source !== 'none' && clockOf(other).slice(0, 10) === day.local_time)).map(({ event }) => event);
}

/**
 * The UPU's events at an office of exchange and at import customs, in the words of the postal
 * feeds and of the posts ParcelsApp relays them for. On a parcel from Mexico to Colombia, UPU's,
 * EMS's and Correos de México's copies of each came at the same minute, with their own places.
 */
const POSTAL_EVENTS: readonly RegExp[] = [
  /^(?:arrived at export office|arrived at international sorting center in country of origin|arrival at outward office of exchange|in the international exchange area towards the destination country\b.*)$/,
  /^(?:departed from export office|departed country of origin|(?:departure|dispatch) from outward office of exchange|piece deposited in a bag and sent to the destination country office)$/,
  /^(?:arrived at destination import office|arrived at sorting center in destination(?: country)?|arrival at inward office of exchange)$/,
  /^(?:item )?presented to import customs$/,
  /^(?:held by customs|held for customs inspection)$/,
];
const postalEvent = (description: string | undefined) => {
  const text = (description ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '').toLowerCase();
  return POSTAL_EVENTS.findIndex((words) => words.test(text));
};

/**
 * One UPU event that two sources ParcelsApp files apart give at the same instant
 * (`POSTAL_EVENTS`) is one scan. The post's own row is kept, else the first with a place.
 */
function dropPostalCopies(events: CarrierEvent[], names: ReadonlyMap<CarrierEvent, unknown>): void {
  const groups = new Map<string, CarrierEvent[]>();
  for (const event of events) {
    const kind = postalEvent(event.description);
    if (kind < 0 || !event.time) continue;
    const key = `${Date.parse(event.time)}|${kind}`;
    groups.set(key, [...groups.get(key) ?? [], event]);
  }
  const copies = new Set<CarrierEvent>();
  for (const group of groups.values()) {
    if (new Set(group.map((event) => nameKey(names.get(event)))).size < 2) continue;
    const kept = group.find((event) => !POSTAL_FEEDS.has(nameKey(names.get(event))))
      ?? group.find((event) => event.location) ?? group[0]!;
    for (const event of group) if (event !== kept) copies.add(event);
  }
  if (copies.size) events.splice(0, events.length, ...events.filter((event) => !copies.has(event)));
}

// Russian Post's summary of a delivery, "Вручено 22 октября" (delivered on 22 October).
const RUSSIAN_POST_SUMMARY = /^вручено \d{1,2} \p{L}+[.!]?$/iu;

/**
 * ParcelsApp lists beside a Russian Post delivery its summary ("Вручено 22 октября"), at the
 * posting office, on the delivery office's wall clock with no carrier to place it: a delivery
 * in Abakan at 13:58 local, 06:58 UTC, came as 13:58. A summary in the delivered stage whose
 * clock is whole hours from a dated delivery's instant, to the second, from one to twelve as
 * Russia's clocks are, repeats that delivery and is left out.
 */
function dropRussianPostSummaries(events: CarrierEvent[], summaries: ReadonlySet<CarrierEvent>): void {
  const clock = (event: CarrierEvent) => Date.parse(event.time ?? (event.local_time ? `${event.local_time}Z` : ''));
  const repeats = [...summaries].filter((summary) => summary.stage === 'delivered' && events.some((scan) => !summaries.has(scan)
    && scan.stage === 'delivered' && scan.time && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(Math.abs(clock(summary) - clock(scan)) / 3_600_000)));
  for (const summary of repeats) events.splice(events.indexOf(summary), 1);
}

/** Leaves out the passed deliveries and the timed steps' untimed twins. */
function dropPassed(events: CarrierEvent[], carried: readonly { event: CarrierEvent; carrier: string }[], steps: ReadonlySet<CarrierEvent>): void {
  const dropped = new Set([...passedDeliveries(events), ...timedTwins(carried, steps)]);
  for (let index = events.length; index--;) if (dropped.has(events[index]!)) events.splice(index, 1);
}

/**
 * The country the parcel is bound for, as the reply names it, or for a reply
 * that does not, as an EcoScooting reference does ("CNPRT" for Portugal,
 * "CNESP" for Spain).
 */
function replyDestination(payload: Record<string, unknown>, number: string): string | null {
  const reference = /^CN(PRT|ESP)\d{20}$/.exec(number)?.[1];
  return statedDestination(payload) ?? (reference === 'PRT' ? 'PT' : reference === 'ESP' ? 'ES' : null);
}

/** The destination the reply names, which the result reports; a reference's country only dates scans. */
function statedDestination(payload: Record<string, unknown>): string | null {
  return countryCode(payload.destinationCode) ?? countryCode(payload.destination);
}

/**
 * The carrier ParcelsApp follows the parcel to and its number: a number it
 * names next (`next_tracking_ids`) that the own rule of the newest scan's
 * carrier claims, as DPD's number for a line's parcel DPD now carries. Only
 * one such pair names the partner. A number of a carrier with no later scan,
 * an earlier leg's for one, names none.
 */
function nextPartner(payload: Record<string, unknown>, events: readonly CarrierEvent[], names: ReadonlyMap<CarrierEvent, unknown>,
  number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const next = Array.isArray(payload.next_tracking_ids) ? payload.next_tracking_ids : [];
  const ids = next.filter((id): id is string => typeof id === 'string' && /^[A-Z0-9]{4,40}$/.test(id) && id !== number).slice(0, 10);
  const newest = events[0];
  if (!ids.length || !newest) return {};
  const pairs = new Map<string, { carrier: string; id: string }>();
  for (const event of events.filter((scan) => scan.time === newest.time && scan.local_time === newest.local_time)) {
    const name = names.get(event);
    if (typeof name !== 'string') continue;
    for (const id of ids) {
      const carrier = carrierIdFromName(name) ?? brandCarrierForNumber(name, id);
      if (carrier && (detectCarrierMatch(id).candidates as readonly string[]).includes(carrier)) pairs.set(`${carrier} ${id}`, { carrier, id });
    }
  }
  const [partner, ...others] = pairs.values();
  return partner && !others.length ? { delivery_carrier: partner.carrier, delivery_tracking_number: partner.id } : {};
}

/** The country the parcel comes from, as the reply names it, else the post that issued an S10 number. */
function replyOrigin(payload: Record<string, unknown>, number: string): string | null {
  return countryCode(payload.originCode) ?? countryCode(payload.origin) ?? countryCode(/^[A-Z]{2}\d{9}([A-Z]{2})$/.exec(number)?.[1]);
}

/**
 * ParcelsApp's own forecast, a row dated the expected day that the
 * destination's post names: no scan, and dated ahead of the read.
 */
const FORECAST = /^estimated delivery$/i;

// How far after the read a scan that only a guess dates may come out.
const GUESS_LEAD_MS = 60 * 60 * 1_000;

/**
 * Whether a scan with no place that only routing's zone or ParcelsApp's label
 * dates comes out more than an hour after the read. Its clock is another: a
 * Cainiao step on China's wall clock, read on the UTC of EcoScooting's catalog,
 * came out 7.6 hours ahead. It is held back until a read catches up with it.
 * A scan its carrier's clock or its place dates keeps its time, so that the
 * alert on scans dated ahead still shows a wrong clock there.
 */
function guessedAhead(event: CarrierEvent, location: string, zone: string | null, routing: string | null, readAt: number): boolean {
  return !location && (!zone || zone === routing) && typeof event.time === 'string' && Date.parse(event.time) > readAt + GUESS_LEAD_MS;
}

/**
 * GEODIS Poland's summary status before its first scan, which ParcelsApp
 * relays under "Pekaes" dated ten minutes after its own read on Warsaw's
 * clock, a new date each time it reads the tracker again: no scan.
 */
const PEKAES_SUMMARY = /^transferred data$/i;
const summaryRow = (name: unknown, status: string) => nameKey(name) === 'pekaes' && PEKAES_SUMMARY.test(status);

// An HTML tag: Bring Denmark's label links the parcel shop it names, which ParcelsApp relays as markup.
const MARKUP = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi;

/**
 * ParcelsApp relays some carriers' labels twice over, TIPSA's as
 * "ENTREGADOENTREGADO". Only a label made of two identical halves is collapsed.
 * A label's markup is left out and the text it marks kept.
 */
function relayedLabel(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const unmarked = text.replace(MARKUP, '');
  const label = (unmarked === text ? text : unmarked.replace(/\s+/g, ' ')).trim();
  const half = label.length / 2;
  return Number.isInteger(half) && label.slice(0, half) === label.slice(half) ? label.slice(0, half) : label;
}

/**
 * Mayi Yinfu's hand-over to the airport, "货物已交机场", which its own rows
 * translate as "The goods have been delivered to the airport". ParcelsApp has
 * relayed those rows as a bare "Delivered" placed in China, before the flight:
 * transit, not a delivery. The forwarder's rows of the delivery are the
 * delivering carrier's, worded in full and placed in the destination.
 */
function airportHandOver(carrier: string | undefined, status: string, location: string, destination: string | null): CarrierScan | undefined {
  return carrier === 'mayiyinfu' && destination !== 'CN' && /^delivered[.!]?$/i.test(status)
    && (countryCode(lastPlace(location)) === 'CN' || inChina(location))
    ? { stage: 'in_transit', wording: 'The goods have been delivered to the airport' } : undefined;
}

/**
 * The dates among a reply's that stand for none: 1 January at 00:00, more
 * than PLACEHOLDER_LEAD_DAYS before every other dated scan. ParcelsApp relays
 * the steps of DPD's progress bar and gives that date to those DPD leaves
 * undated, months before the parcel's scans. A real scan at that minute lies
 * among the scans of the turn of the year, and keeps its date.
 */
function placeholderDates(dates: readonly unknown[]): Set<string> {
  const walls = dates.map((date) => mislabeledWallTime(date));
  const newYear = (wall: string | null): wall is string => wall !== null && /^\d{4}-01-01T00:00:00(?:\.0+)?$/.test(wall);
  const others = walls.filter((wall): wall is string => wall !== null && !newYear(wall)).sort();
  if (!others.length) return new Set();
  const first = DateTime.fromISO(others[0]!, { zone: 'utc' });
  return new Set(walls.filter(newYear)
    .filter((wall) => first.diff(DateTime.fromISO(wall, { zone: 'utc' }), 'days').days > PLACEHOLDER_LEAD_DAYS));
}

/**
 * ParcelsApp's own lookup at the carrier failed: its page words these codes as the
 * carrier's website being down, busy, unreadable, under maintenance or refusing automated
 * tracking. The answer concerns that carrier, not the shipment or ParcelsApp's other
 * carriers, and the browser page would ask the same lookup.
 */
const CARRIER_FAILURES = new Set(['DOWN', 'BUSY', 'PARSER', 'CAPTCHA', 'MAINTENANCE']);

/**
 * On a parcel to the US, DHLink's feed holds a partner's scan twice: its own
 * row on China's clock and the partner's copy on the partner's US wall clock
 * (carriers/dhlink). ParcelsApp files both under DHLink, where the copy, read
 * on China's clock, would come hours early: it goes when a US reading of its
 * clock gives the instant of DHLink's row with the same wording, or when the
 * partner's own row, filed under the partner, has the same wording at the
 * same digits. The reply can hold the copy without DHLink's row.
 */
function dropDhlinkCopies(entries: { name: unknown; date: unknown; wording: string }[]): void {
  const fromDhlink = ({ name }: { name: unknown }) => typeof name === 'string' && carrierIdFromName(name) === 'dhlink';
  const dhlink = entries.filter(fromDhlink);
  const scanKey = (wall: string, wording: string) => `${wall}|${wording.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  const partners = new Set(entries.filter((entry) => !fromDhlink(entry))
    .map(({ date, wording }) => scanKey(mislabeledWallTime(date) ?? '', wording)));
  const copies = new Set(dhlink.filter((copy) => {
    const wall = mislabeledWallTime(copy.date);
    return wall && (partners.has(scanKey(wall, copy.wording)) || dhlink.some((own) => {
      const time = own !== copy && own.wording === copy.wording ? mislabeledLocalTime(own.date, DHLINK_RECORD_ZONE) : null;
      return time && usClockCopy(wall, time.timestamp);
    }));
  }));
  if (copies.size) entries.splice(0, entries.length, ...entries.filter((entry) => !copies.has(entry)));
}

/**
 * 4PX Express's page relays its last-mile partner's scans in Spanish at the partner's digits
 * to the second: on a parcel to the US, each of GOFO's scans came again under 4PX ("Llegó al
 * centro regional de gofo"), with another scan's place or none, and read on another clock
 * than GOFO's own, an hour apart. A relay's state at the second and stage of its partner's state
 * is that copy and is not read as a scan; a scan of another stage at that second, as 4PX's own
 * departure beside GOFO's label, is not. It still lends its zone to the relay's own scans, as
 * the clock of the relay's network. A second of :00 can be a minute-only clock's, so it
 * matches nothing.
 */
const RELAYED_PARTNERS = new Map([['4pxexpress', new Set(['gofoexpress'])]]);
function relayCopies<T extends { name: unknown; date: unknown; wording: string; scan: CarrierScan | undefined }>(entries: readonly T[]): Set<T> {
  const second = (date: unknown) => {
    const wall = mislabeledWallTime(date);
    return wall && !/:00(?:\.0+)?$/.test(wall) ? wall.slice(0, 19) : '';
  };
  const stage = (entry: T) => entry.scan?.stage ?? eventStage(entry.wording);
  return new Set(entries.filter((copy) => {
    const partners = RELAYED_PARTNERS.get(nameKey(copy.name));
    const key = partners ? second(copy.date) : '';
    return key && entries.some((own) => partners!.has(nameKey(own.name)) && second(own.date) === key && stage(own) === stage(copy));
  }));
}

/**
 * Another network's copy of a scan dated by its day alone (`datedOnly`, `dayOnlyNetworks`): the
 * same words at 00:00:00 that day, as read (any delivery's are its stage, `copyWording`), with no place.
 * Cainiao relayed Czech Post's delivery so, beside Czech Post's own with its day and office.
 * The copy is not read as a scan.
 */
function midnightCopies<T extends { name: unknown; date: unknown; location: string; wording: string; raw: Record<string, unknown> }>(
  entries: readonly T[],
  dayOnly: ReadonlySet<string>,
): Set<T> {
  const words = (entry: T, wall: string) => {
    const parsed = localEvent(wall, entry.wording);
    return (parsed ? copyWording(parsed) : '').replace(/\s+/g, ' ').trim().toLowerCase();
  };
  const dayOf = (entry: T) => datedOnly(entry.name, relayedLabel(entry.raw.status), entry.date) ?? networkDay(dayOnly, entry.name, entry.date);
  const dated = entries.flatMap((entry) => {
    const [day, wall] = [dayOf(entry), mislabeledWallTime(entry.date)];
    return day && wall ? [{ network: nameKey(entry.name), day, wording: words(entry, wall) }] : [];
  });
  return new Set(dated.length ? entries.filter((copy) => {
    const wall = mislabeledWallTime(copy.date);
    if (!wall || !/T00:00:00(?:\.0+)?$/.test(wall) || copy.location.trim() || dayOf(copy)) return false;
    const wording = words(copy, wall);
    return wording !== '' && dated.some((scan) => scan.network !== nameKey(copy.name) && scan.day === wall.slice(0, 10) && scan.wording === wording);
  }) : []);
}

/**
 * ParcelsApp's own check of the number's form, sent as the reply's only state with no carrier
 * or place: "One digit is missing from the tracking number." It is no scan.
 */
const NUMBER_FORM = /^(?:one|two|three|\d+) digits? (?:is|are) missing from the tracking number\.?$/i;
const numberFormNotice = (raw: unknown): boolean => isRecord(raw) && typeof raw.status === 'string'
  && NUMBER_FORM.test(raw.status.trim()) && !raw.carrier && !raw.location;

/**
 * ParcelsApp's refusal of a request it does not take for its website's: NO_DATA alone. Its
 * answer for a number it has no data for also lists the carriers and services it checked.
 */
// A bare NO_DATA, or the website's explicit block of the requesting network.
const refused = (payload: unknown): boolean => isRecord(payload)
  && ((payload.error === 'NO_DATA' && Object.keys(payload).length === 1) || payload.error === 'IP_BLOCKED');

const refusal = () => new IndeterminateError(SOURCE, 'ParcelsApp refused the lookup', { reason: 'guest_refused' });

function parseHistory(payload: unknown, trackingNumber: string, timezone: string | null = null, readAt = Date.now(),
  filed: string | null = null): CarrierResult {
  // TICKET: the page's ticket was not accepted; the website asks for a new one, then reloads.
  if (isRecord(payload) && (payload.error === 'RELOAD' || payload.error === 'TICKET')) throw new ChallengeError(SOURCE);
  if (refused(payload)) throw refusal();
  if (isRecord(payload) && (payload.error === 'NO_DATA' || payload.error === 'NO_TRACKER')) {
    throw new NoHistoryError(SOURCE, 'ParcelsApp has no usable shipment history');
  }
  if (isRecord(payload) && typeof payload.error === 'string' && CARRIER_FAILURES.has(payload.error)) {
    throw new IndeterminateError(SOURCE, `ParcelsApp's carrier lookup failed: ${payload.error}`, { reason: 'carrier_unavailable' });
  }
  if (!isRecord(payload) || payload.error || !Array.isArray(payload.states) || payload.states.length > MAX_EVENTS) {
    // An error code the adapter does not know is named, to tell drift from a new answer.
    const code = isRecord(payload) && typeof payload.error === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(payload.error) ? `: ${payload.error}` : '';
    throw new SchemaError(SOURCE, `ParcelsApp lookup unavailable${code}`);
  }
  if (payload.states.length && payload.states.every(numberFormNotice)) {
    throw new InvalidInputError(SOURCE, 'ParcelsApp reports the tracking number is incomplete');
  }
  const number = numberOf(trackingNumber);
  const events: CarrierEvent[] = [];
  const carried: { event: CarrierEvent; carrier: string }[] = [];
  const scans: { event: CarrierEvent; scan: CarrierScan }[] = [];
  const scanCarriers = new Set<unknown>();
  const names = new Map<CarrierEvent, unknown>();
  const summaries = new Set<CarrierEvent>();
  let undated = 0;
  // The reply is in North America when a scan certainly is, or when a scan
  // names a state or province ("Atlanta, GA") and none names another country
  // or the parcel is bound for the US or Canada. A parcel from China names
  // China first: GOFO's hub "EXAMPLE, CA" is then California's, where GOFO's
  // own tracker dates the scan at ParcelsApp's digits.
  // A code the reply's own origin or destination names is distrusted as a state or province
  // (`replyCodes`), and a parcel bound for another country is not in North America by its
  // uncertain codes alone.
  const destination = replyDestination(payload, number);
  const origin = countryCode(payload.originCode) ?? countryCode(payload.origin);
  const ends = new Set([...ownCountryCodes(origin), ...ownCountryCodes(destination)]);
  const distrustedAt = replyCodes(payload, payload.states, origin, destination);
  const kinds = payload.states.flatMap((raw: unknown) => {
    const location = isRecord(raw) ? scanLocation(stateCarrierName(payload, raw), raw.location) : '';
    return location ? [placeKind(location, ends)] : [];
  });
  const boundElsewhere = destination !== null && destination !== 'US' && destination !== 'CA';
  const inNorthAmerica = kinds.includes('certain')
    || (kinds.includes('region') && ((!kinds.includes('abroad') && !boundElsewhere) || destination === 'US' || destination === 'CA'));
  const entries: (ReturnType<typeof readState> & { raw: Record<string, unknown>; scan: CarrierScan | undefined; wording: string })[] = [];
  const placeholders = placeholderDates(payload.states.flatMap((raw: unknown) => isRecord(raw) && !raw.require_fields && !raw.error ? [raw.date] : []));
  for (const row of payload.states) {
    if (!isRecord(row)) throw new SchemaError(SOURCE, 'ParcelsApp returned an invalid event');
    if (row.require_fields || row.error) continue;
    const raw = muserPlacedRow(payload, row, destination);
    // A state can come without a date (an Asendia Spain leg), or with a
    // placeholder for one. It has no place among the dated scans, so it is
    // counted instead of read as the latest.
    if (raw.date == null || raw.date === '' || placeholders.has(mislabeledWallTime(raw.date) ?? '')) {
      undated++;
      continue;
    }
    const status = relayedLabel(raw.status);
    if (FORECAST.test(status) || summaryRow(stateCarrierName(payload, raw), status)) continue;
    const state = readState(payload, raw, status, timezone, number, inNorthAmerica, destination, origin, distrustedAt(raw.date), filed);
    const carrier = typeof state.name === 'string' ? carrierIdFromName(state.name) : undefined;
    const scan = carrierScan(carrier, status) ?? airportHandOver(carrier, status, state.location, destination);
    entries.push({ ...state, raw, scan, wording: scan?.wording ?? status });
  }
  if (destination === 'US') dropDhlinkCopies(entries);
  dropStepNotices(entries, eventStage);
  // Another carrier's copy of a scan placed in its state or province (Cainiao
  // relaying UniUni's delivery at the same minute in its own words, with no
  // place) takes that scan's zone, so the two stay one scan. A copy of a GOFO scan with an
  // offset of its own writes the same digits under a UTC label (YTO's, Cirro's
  // and EQuick's of GOFO France's), and takes that offset. A wall-clock scan
  // with no place copies any other carrier's placed scan this way.
  const copyKey = ({ date, wording }: typeof entries[number], wall = mislabeledWallTime(date)) => {
    const parsed = wall ? localEvent(wall, wording) : null;
    const text = parsed ? copyWording(parsed) : '';
    return wall && text ? `${wall}|${text}` : '';
  };
  const offsetClocks = entries.filter((entry) => entry.offset).map((entry) => [
    copyKey(entry, DateTime.fromISO(String(entry.date).trim(), { setZone: true }).toISO({ includeOffset: false })), `UTC${entry.offset}`] as const);
  const localClocks = new Map([
    ...entries.filter((entry) => entry.local).map((entry) => [copyKey(entry), entry.zone!] as const), ...offsetClocks,
  ].filter(([key]) => key));
  // Two placed scans with the same key on different clocks place no copy.
  const placedClocks = new Map<string, string>();
  for (const [key, zone] of [...entries.flatMap((entry) => entry.placed ? [[copyKey(entry), entry.placed] as const] : []), ...offsetClocks]) {
    if (key) placedClocks.set(key, placedClocks.has(key) && placedClocks.get(key) !== zone ? '' : zone);
  }
  // A placed scan written to the minute alone is copied by one that keeps its seconds: YFH's
  // scans come at :00 and Cainiao's copies of them, with no place, at the second. Cainiao's
  // own tracker gives those copies GMT+08:00, the clock YFH's are read on.
  const minuteKey = (entry: typeof entries[number]) => {
    const wall = mislabeledWallTime(entry.date);
    return wall ? copyKey(entry, wall.slice(0, 16)) : '';
  };
  const minuteClocks = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.placed && /:00(?:\.0+)?$/.test(mislabeledWallTime(entry.date) ?? '') ? minuteKey(entry) : '';
    if (key) minuteClocks.set(key, minuteClocks.has(key) && minuteClocks.get(key) !== entry.placed ? '' : entry.placed!);
  }
  const zones = wallClockZones(entries.map((entry) => ({ ...entry,
    zone: entry.wallClock ? entry.zone : (localClocks.size && !entry.local && !entry.offset ? localClocks.get(copyKey(entry)) : undefined) ?? entry.zone,
    copy: entry.wallClock && !entry.zone ? placedClocks.get(copyKey(entry)) || minuteClocks.get(minuteKey(entry)) || undefined : undefined })));
  placeCopies(entries).forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'copy' }; });
  copiedNetworkZones(entries.map((entry, index) => ({ name: entry.name, key: copyKey(entry), zone: zones[index]!.zone,
    fixed: Boolean(entry.offset) || relaysFacilityClock(entry.name), location: entry.location })))
    .forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'copy' }; });
  chinaPostTwinZones(entries, zones.map(({ zone }) => zone), destination)
    .forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'copy' }; });
  relayTwinZones(entries, zones).forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'copy' }; });
  postalTwinZones(entries, zones, origin).forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'copy' }; });
  yunExpressDestinationZones(entries, zones, destination).forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'borrowed' }; });
  yunExpressOriginZones(entries, zones).forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'borrowed' }; });
  const relayed = relayCopies(entries);
  const dayOnly = dayOnlyNetworks(entries);
  const midnight = midnightCopies(entries, dayOnly);
  const dialed = twelveHourCopies(entries, zones);
  const steps = new Set<CarrierEvent>();
  const latest = new LatestScan(SOURCE);
  for (const [index, entry] of entries.entries()) {
    if (relayed.has(entry) || midnight.has(entry) || dialed.has(entry)) continue;
    const { raw, name, scan, date } = entry;
    const { zone } = zones[index]!;
    // A DHL Express scan whose facility the rule cannot place is a wall clock
    // with no instant, and so is a UPS or FedEx scan with no location, or
    // placed only in the US or Canada (`nationwide`), that nothing places.
    // A scan at a US military post office, of a network no
    // table knows (`unknownNetwork`), of a bare brand on local clocks
    // (`localClockBrand`), of iMile for a destination of several zones, of
    // Croatia Post without an office or at an office abroad that its code does not place, of UPU at
    // an office in the destination (`destinationOffice`) or of a line on its
    // place's clock that its place does not date (`PLACE_CLOCK_LINES`) keeps
    // its wall clock as its local time. Any other
    // scan with no zone keeps ParcelsApp's label.
    const facility = !zone && relaysFacilityClock(name);
    const unplaced = !zone && unplacedLocalClock(entry);
    const localOnly = !zone && !unplaced && entry.wallOnly;
    // A step or network its carrier dates by the day alone keeps the day (`datedOnly`, `dayOnlyNetworks`).
    const step = datedOnly(name, relayedLabel(raw.status), date);
    const day = step ?? networkDay(dayOnly, name, date);
    const parsed = day ? dayEvent(day, entry.wording)
      : localEvent((zone ? mislabeledLocalTime(date, zone)?.iso : unplaced || localOnly ? mislabeledWallTime(date) : undefined) ?? date, entry.wording);
    if (parsed) latest.see(mislabeledWallTime(date) ?? '', facility);
    // Nor has an offset-less date that no zone resolves: a wall time, not an instant.
    if (parsed && !parsed.time && !day && !localOnly) {
      undated++;
      continue;
    }
    if (parsed && (guessedAhead(parsed, entry.location, zone, timezone, readAt) || uspsAhead(name, entry.location, zone, parsed, readAt))) continue;
    if (parsed) {
      // Some Chronopost rows put the service label in the location field.
      const location = scan?.location ?? (libSite(name, raw.location) ? '' : reportedPlace(raw.location));
      if (location && !/^Type de livraison\s*:/i.test(location)) parsed.location = location;
      // China Post words its labels in Chinese only, also those it gives the destination post's scans:
      // they show in English where it is known, staged as the Chinese was, with the place left to the
      // location, or taken from the label's 【】 where none is given, as 17TRACK's copies of them are.
      const english = !scan && typeof name === 'string' && carrierIdFromName(name) === 'china-post'
        && /\p{Script=Han}/u.test(parsed.description ?? '') ? chinaPostEnglish(parsed.description!) : undefined;
      if (english) {
        const named = parsed.location ? '' : reportedPlace(chinaPostLabelPlace(parsed.description!) ?? '');
        parsed.description = english;
        if (named) parsed.location = named;
      }
      const basis = parsed.time && !day ? zoneBasis(entry, zones[index]!.step, zone) : undefined;
      if (basis) Object.assign(parsed, { time_zone: zone ?? 'UTC', time_zone_basis: basis });
      events.push(parsed);
      carried.push({ event: parsed, carrier: nameKey(name) });
      scanCarriers.add(name);
      names.set(parsed, name);
      if (RUSSIAN_POST_SUMMARY.test(relayedLabel(raw.status))) summaries.add(parsed);
      if (step) steps.add(parsed);
    }
    if (parsed && scan) scans.push({ event: Object.assign(parsed, { stage: scan.stage, stage_source: 'carrier_map' }), scan });
  }
  markReturnLeg(scans);
  markLaterReceipts(scans);
  markYunExpressIntake(carried);
  markHandovers(carried);
  dropPassed(events, carried, steps);
  dropRussianPostSummaries(events, summaries);
  dropPostalCopies(events, names);
  latest.check();
  if (!events.length) {
    const gates = payload.states.filter((raw: unknown): raw is Record<string, unknown> => isRecord(raw)
      && Array.isArray(raw.require_fields) && raw.require_fields.some((field: unknown) => isRecord(field) && field.name === 'zipcode'));
    if (gates.length) {
      // A gate names the carrier that asks for the postcode, as a scan does. It is
      // given only when every gate names the same one and it maps to the catalog.
      const [name, ...others] = gates.map((gate) => stateCarrierName(payload, gate));
      const carrier = typeof name === 'string' && others.every((other) => other === name)
        ? universalCarrierHints([name], number).discovered_carrier : undefined;
      throw new InputRequiredError(SOURCE, 'postcode', 'ParcelsApp requires a valid delivery postcode or further recipient information',
        carrier ? { carrier } : undefined);
    }
    // An empty history is the NO_DATA answer; states that don't parse are not an answer.
    if (!payload.states.length) throw new NoHistoryError(SOURCE, 'ParcelsApp has no usable shipment history');
    throw new IndeterminateError(SOURCE, 'No usable tracking events');
  }
  // The carriers ParcelsApp aggregated for this number ("DPD Group"), as
  // discovery hints; routing confirms one with its own adapter before adopting it.
  // ParcelsApp lists its link to another tracker, among `next_tracking_ids`,
  // as a carrier and a service named "url": no carrier's name.
  const services = Array.isArray(payload.services) ? payload.services : [];
  const carriers: unknown[] = Array.isArray(payload.carriers) ? payload.carriers : [];
  const hints = universalCarrierHints([
    ...carriers, ...services.map((service: unknown) => isRecord(service) ? service.name : undefined),
  ].filter((name) => !(typeof name === 'string' && /^url$/i.test(name.trim()))).slice(0, 20), number);
  const stated = statedDestination(payload);
  const answer = result(events, SOURCE);
  const partner = nextPartner(payload, answer.events ?? [], names, number);
  // The list also names carriers asked without an answer. When every scan
  // names the same carrier, that carrier is the hint, unless they are its rows
  // under the number ParcelsApp names next for it and the number's own rules do
  // not point to it: Hermes's under its own number, for a forwarder's reference.
  const scanned = scanCarriers.size === 1 ? universalCarrierHints([...scanCarriers], number).discovered_carrier : undefined;
  const partnerRows = scanned !== undefined && partner.delivery_carrier === scanned
    && !(detectCarrierMatch(number).candidates as readonly string[]).includes(scanned);
  const discovered = hints.discovered_carrier ?? (partnerRows ? undefined : scanned);
  return { ...answer, ...(undated ? { undated_event_count: undated } : {}),
    ...hints, ...(discovered ? { discovered_carrier: discovered } : {}), ...(stated ? { destination_country: stated } : {}),
    ...partner };
}

/** Whether a direct request failed by reaching its own cap rather than by a network failure. */
function timedOut(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 8; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') return true;
  }
  return false;
}

function browserCanRecover(error: unknown): boolean {
  // A slow uncached lookup needs more time on the same API. It has already
  // had one direct retry; a new browser lookup would repeat the work again.
  if (error instanceof UpstreamNetworkError) return false;
  // A second lookup cannot repair missing input, rate limiting or an outage.
  if (error instanceof UpstreamHttpError && (error.status === 429 || error.status >= 500)) return false;
  // The browser tier reads a larger reply than the direct POST's cap.
  if (error instanceof CarrierError && error.reason === 'response_too_large') return true;
  const kind = carrierErrorKind(error);
  return kind === null || kind === 'challenge' || kind === 'transport' || kind === 'schema';
}

export function parseParcelsAppHtml(html: string, trackingNumber: string, timezone: string | null = null, readAt = Date.now()): CarrierResult {
  return parseHtml(html, trackingNumber, timezone, readAt, null);
}

/** The rendered page, for a parcel filed under a carrier (`filedNetworkZone`) or none. */
function parseHtml(html: string, trackingNumber: string, timezone: string | null, readAt: number, filed: string | null): CarrierResult {
  if (!parcelsIdentity(html, numberOf(trackingNumber))) throw new SchemaError(SOURCE, 'ParcelsApp shipment identity missing');
  const $ = load(html);
  const nodes = $('.tracking-info .parcel .events > .event');
  if (nodes.length > MAX_EVENTS) throw new SchemaError(SOURCE, 'ParcelsApp returned too many events');
  const events: CarrierEvent[] = [];
  // Each scan names its carrier ("DPD Group") under its wording, as the JSON
  // reply's `carriers` index does: the same zone rules then give the same
  // instants, and so the same event ids, whichever tier answered.
  const carriers: string[] = [];
  const carried: { event: CarrierEvent; carrier: string }[] = [];
  const scans: { event: CarrierEvent; scan: CarrierScan }[] = [];
  const rows: { name: string; description: string; state: ReturnType<typeof readState>; scan: CarrierScan | undefined }[] = [];
  let undated = 0;
  const latest = new LatestScan(SOURCE);
  nodes.each((_, node) => {
    const row = $(node);
    if (row.find('input, select, form').length) return;
    const description = relayedLabel(row.find('.event-content > strong').first().text());
    if (isNotice(description) || FORECAST.test(description)) return;
    const date = row.find('.event-time > strong').text().trim();
    const time = row.find('.event-time > span').text().trim();
    // Notice rows ("No information about your package...") render a date with
    // an empty time. Skip them instead of failing the whole history.
    if (!time) return;
    const name = row.find('.event-content .carrier').first().text().replace(/\s+/g, ' ').trim();
    if (name && !carriers.includes(name)) carriers.push(name);
    if (summaryRow(name, description)) return;
    // The page prints a state without a date as "aN Inv NaN" at "aN:aN":
    // counted, as in the JSON reply.
    if (date.includes('NaN')) {
      undated++;
      return;
    }
    // The English web app renders the UTC digits of its API, which are the
    // scan's local clock.
    const labeled = DateTime.fromFormat(paddedDate(`${date} ${time}`), 'dd LLL yyyy HH:mm', { locale: 'en', zone: 'UTC' });
    if (!labeled.isValid) throw new SchemaError(SOURCE, 'ParcelsApp returned an invalid event date');
    const state = readState({ carriers }, { date: labeled.toISO(), ...(name ? { carrier: carriers.indexOf(name) } : {}) },
      description, timezone, numberOf(trackingNumber), false, replyDestination({}, numberOf(trackingNumber)), null, NO_CODES, filed);
    const scan = carrierScan(name ? carrierIdFromName(name) : undefined, description);
    rows.push({ name, description, state, scan });
  });
  // A placeholder date is counted, as in the JSON reply.
  const placeholders = placeholderDates(rows.map(({ state }) => state.date));
  const placeholder = ({ state }: typeof rows[number]) => placeholders.has(mislabeledWallTime(state.date) ?? '');
  undated += rows.filter(placeholder).length;
  rows.splice(0, rows.length, ...rows.filter((row) => !placeholder(row)));
  // The page prints no location, so no DHL Express scan has a facility to
  // read its clock in, and no other wall clock a place, a copy to take or a
  // placed scan of its network to borrow from: routing's zone, its known
  // clock or its label, else the clock its copies show, as in the JSON reply.
  const zones = rows.map(({ state }) => state.zone ?? state.fallback ?? state.known);
  const zoneSteps = rows.map(({ state }): ZoneStep => state.zone ? 'carrier' : state.fallback ? 'routing' : state.known ? 'known' : 'labeled');
  copiedNetworkZones(rows.map(({ name, description, state, scan }, index) => {
    const wall = mislabeledWallTime(state.date);
    const parsed = wall ? localEvent(wall, scan?.wording ?? description) : null;
    const text = parsed ? copyWording(parsed) : '';
    return { name, key: wall && text ? `${wall}|${text}` : '', zone: zones[index]!,
      fixed: Boolean(state.offset) || relaysFacilityClock(name), location: '' };
  })).forEach((zone, index) => {
    if (zone) [zones[index], zoneSteps[index]] = [zone, 'copy'];
  });
  const dayOnly = dayOnlyNetworks(rows.map(({ name, state }) => ({ name, date: state.date, offset: state.offset })), true);
  const steps = new Set<CarrierEvent>();
  for (const [index, { name, description, state, scan }] of rows.entries()) {
    const zone = zones[index]!;
    const unplaced = !zone && relaysFacilityClock(name);
    latest.see(mislabeledWallTime(state.date) ?? '', unplaced);
    if (unplaced) {
      undated++;
      continue;
    }
    const step = datedOnly(name, description, state.date);
    const day = step ?? networkDay(dayOnly, name, state.date);
    // A scan whose label nothing vouches for keeps its wall clock, as in the JSON reply.
    const wall = !zone && state.wallOnly ? mislabeledWallTime(state.date) : null;
    const parsed = day ? dayEvent(day, scan?.wording ?? description)
      : wall ? localEvent(wall, scan?.wording ?? description)
        : event((zone ? mislabeledLocalTime(state.date, zone)?.iso : undefined) ?? state.date, scan?.wording ?? description);
    if (parsed && guessedAhead(parsed, '', zone, timezone, readAt)) continue;
    if (parsed && scan?.location) parsed.location = scan.location;
    const basis = parsed?.time && !day ? zoneBasis(state, zoneSteps[index]!, zone) : undefined;
    if (parsed && basis) Object.assign(parsed, { time_zone: zone ?? 'UTC', time_zone_basis: basis });
    if (parsed) events.push(parsed);
    if (parsed) carried.push({ event: parsed, carrier: nameKey(name) });
    if (parsed && step) steps.add(parsed);
    if (parsed && scan) scans.push({ event: Object.assign(parsed, { stage: scan.stage, stage_source: 'carrier_map' }), scan });
  }
  markReturnLeg(scans);
  markLaterReceipts(scans);
  markYunExpressIntake(carried);
  markHandovers(carried);
  dropPassed(events, carried, steps);
  latest.check();
  return { ...result(events, SOURCE), ...(undated ? { undated_event_count: undated } : {}),
    ...universalCarrierHints(carriers.slice(0, 20), numberOf(trackingNumber)) };
}

export interface ParcelsAppOptions {
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  timeoutMs?: number;
  /** Null runs only the existing browser capture tier. */
  httpClient?: ParcelsAppHttpClient | null;
}

export class ParcelsAppTracker {
  private readonly http: ParcelsAppHttpClient | null;

  constructor(readonly options: ParcelsAppOptions = {}) {
    this.http = options.httpClient === undefined ? new ParcelsAppHttpClient(options.fetcher) : options.httpClient;
  }

  async fetch(trackingNumber: string, budgetMs = this.options.timeoutMs ?? PARCELSAPP_BUDGET_MS, postcode?: string | null, timezone: string | null = null,
    signal?: AbortSignal, carrier: string | null = null): Promise<CarrierResult> {
    const number = numberOf(trackingNumber);
    if (!Number.isFinite(budgetMs) || budgetMs < 1) throw new TypeError('ParcelsApp timeout must be positive');
    const deadline = performance.now() + budgetMs;
    const request = async (remainingMs: number, signal: AbortSignal): Promise<CarrierResult> => {
      const payload = await this.http!.fetch(number, Math.max(1, Math.min(DIRECT_BUDGET_MS, Math.floor(remainingMs))), postcode, signal);
      // This endpoint returns one shipment per POST, synchronously, with no
      // shared session or polling handle. Each retry keeps its own request
      // binding. Numberless browser captures never get this exemption.
      if (isRecord(payload) && payload.correctId && payload.correctId !== number) {
        throw new SchemaError(SOURCE, 'ParcelsApp returned an unverified tracking alias');
      }
      return { ...parseHistory(payload, number, timezone, Date.now(), carrier), tracking_source: 'structured-web-response' };
    };
    return runSteps({ carrier: SOURCE, budgetMs, signal, recorder: this.options.recorder }, [{
      id: 'direct',
      enabled: this.http !== null,
      run: ({ remainingMs, signal }) => request(remainingMs, signal),
    }, {
      id: 'retry',
      enabled: this.http !== null,
      // Retry a replayable network failure with the same input, within the
      // original lookup budget. A request ParcelsApp held to its cap is not
      // retried: the one sent two seconds later waited out the rest of the
      // budget as well, for every Royal Mail parcel tried from production
      // (2026-10-16), while a cold lookup answered within 16 s.
      recovers: (error) => error instanceof UpstreamNetworkError && !timedOut(error) && deadline - performance.now() > RETRY_DELAY_MS + 1,
      run: async ({ signal }) => {
        await timers.setTimeout(RETRY_DELAY_MS, undefined, { signal });
        signal.throwIfAborted();
        return request(deadline - performance.now(), signal);
      },
    }, {
      id: 'trawl',
      enabled: this.options.trawl != null || this.http === null,
      recovers: browserCanRecover,
      run: async ({ remainingMs, signal }) => {
        const capture: CaptureSpec = {
          source: SOURCE, url: `https://parcelsapp.com/en/tracking/${number}`, apiUrl: PARCELSAPP_API,
          budgetMs: remainingMs, fetcher: this.options.fetcher, signal,
        };
        const page = await loadCapture(this.options.trawl ?? null, capture);
        let noData = false;
        let refusedReply = false;
        for (const body of capturedBodies(page, capture)) {
          let payload: unknown;
          try {
            payload = JSON.parse(body);
            return parseResponse(payload, number, page.html, timezone, Date.now(), carrier);
          } catch {
            // Polling replies, unrelated numbers and demo shipments are not history.
            refusedReply ||= refused(payload);
            noData ||= !refused(payload) && isRecord(payload) && (payload.error === 'NO_DATA' || payload.error === 'NO_TRACKER');
          }
        }
        if (refusedReply && !noData) {
          // A refused page has no history to render; read one only if it does.
          try {
            return parseHtml(page.html, number, timezone, Date.now(), carrier);
          } catch {
            throw refusal();
          }
        }
        // For a number it has no data for, ParcelsApp renders its empty view, which
        // leaves out the number, so no reply can be bound to it. With the page's own
        // NO_DATA that is the direct step's inconclusive answer; without, inconclusive.
        if (emptyView(page.html)) {
          throw noData ? new NoHistoryError(SOURCE, 'ParcelsApp has no usable shipment history') : captureFailure(page, capture);
        }
        // The rendered page carries the same history when no body was readable.
        return parseHtml(page.html, number, timezone, Date.now(), carrier);
      },
    }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ParcelsAppTracker({
    trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder,
  });
  return {
    id: SOURCE,
    steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context?.budgetMs, input.postcode, input.timezone ?? null, context?.signal, input.carrier ?? null),
  };
};
