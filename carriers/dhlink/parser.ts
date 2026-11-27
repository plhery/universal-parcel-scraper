import { DateTime, FixedOffsetZone } from 'luxon';
import { isValidUspsPackageBarcode, normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { hasGs1CheckDigitInDigits, isValidGofoEuropeWaybill } from '../../core/detection/prefixedChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { uspsRoundDelivery } from '../../core/result/round.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence, isoTime, usStateTimeZone } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/text.js';
import { gofoScanZone } from '../gofo/clock.js';
import { isRecord } from '../../core/types.js';
import { countryZones } from '../../places/zones.js';
import { DHLINK_RECORD_ZONE as RECORD_ZONE, usClockReadings } from './clock.js';
import { dhlinkEnglish, dhlinkRound, dhlinkStage, FLIGHT_BOOKED, PENDING_DELIVERY } from './status.js';

export const PROVIDER = 'DHLink';
// A long history is a few dozen kilobytes.
export const DHLINK_MAX_BYTES = 512 * 1024;
// DHLink numbers, waybills and line providers' numbers: letters and digits, with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The earliest instant a wall clock can stand for: a row still after the read at UTC+14 is written ahead of its time.
const EARLIEST = FixedOffsetZone.instance(14 * 60);
// Some scanners run early.
const CLOCK_SKEW_MS = 3_600_000;
// Stages of a parcel on its way, after which a receipt is no new acceptance.
const MOVED = new Set(['in_transit', 'customs', 'out_for_delivery']);
// A US post office: its state, then the ZIP code ("NY 10001", "NY;10001", "NY, US 10001").
const US_OFFICE = /\b([A-Z]{2})(?:[ ,;]+US)?[ ,;]+\d{5}(?:-\d{4})?\b/;
// A US hub: its town, state and country ("Sampleville, IL, US").
const US_HUB = /,\s*([A-Z]{2})\s*,\s*US$/;
// DHLink's node for the last-mile partner taking the parcel over.
const LAST_MILE_PICKUP = 'TQ001';
// States whose places keep different clocks, so a state does not settle a clock's zone.
const SPLIT_STATES = new Set(['AK', 'AZ', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// DHLink's own number, FC and thirteen digits.
const DHLINK_NUMBER = /^FC\d{13}$/;
const STATE_NOT_FOUND = 1;
const STATE_DELIVERED = 3;
const CJK = /[㐀-鿿豈-﫿]/;
// China's provinces and the cities DHLink's lines leave from, as a place part
// writes them in Latin letters, spaced or not ("SHENZHEN", "shen zhen").
const CHINA_NAMES = new RegExp(`^(?:${[
  'anhui', 'beijing', 'chongqing', 'fujian', 'gansu', 'guangdong', 'guangxi', 'guizhou', 'hainan', 'hebei', 'heilongjiang',
  'henan', 'hubei', 'hunan', 'jiangsu', 'jiangxi', 'jilin', 'liaoning', 'shaanxi', 'shandong', 'shanghai', 'shanxi',
  'sichuan', 'tianjin', 'yunnan', 'zhejiang', 'chengdu', 'dongguan', 'foshan', 'fuzhou', 'guangzhou', 'hangzhou', 'huizhou',
  'jinhua', 'nanjing', 'ningbo', 'putian', 'qingdao', 'quanzhou', 'shantou', 'shenzhen', 'suzhou', 'wenzhou', 'wuhan',
  'xiamen', 'yiwu', 'zhengzhou', 'zhongshan', 'zhuhai',
].join('|')})(?:shi|city)?$`);
const COUNTRY = /^[A-Z]{2}$/;
const PLACEHOLDERS = new Set(['', '.', '-', 'none', 'null', 'unknown', 'system']);
// A forwarder's name a warehouse can write as its place ("SAMPLEEXP", "Sample Logistics"): it names no place.
const FORWARDER = /(?:exp|express|logistics)$/;
// A state with its ZIP code, as relayed USPS rows name the office: the state stays.
const STATE_ZIP = /\b([A-Z]{2})[ ,;]+\d{5}(?:-\d{4})?\b/g;
// British and Canadian postcodes.
const POSTCODE = /\b(?:[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|[A-Z]\d[A-Z] ?\d[A-Z]\d)\b/g;
// Contact or signature details a relayed post can append: the scan's wording is what comes before.
const CONTACT = /(?:投递员|快递员|派送员|联系电话|电话[:：]|手机[:：]|签收人[:：]|代收人[:：]|收件人[:：]|signed (?:for )?by\b|signature[:：]|\btel(?:ephone)?[:.：]|\bphone[:：])[\s\S]*$/i;

/**
 * DHLink's last-leg partners. The reply gives the last leg's number
 * (`lastTurnNo`) but names no partner, so the partner is read from the
 * number's whole layout, and its check digit where `valid` checks one. A number no layout fits gives no hand-off.
 * `countries` keeps a layout other carriers share to the parcels bound where it is the partner's.
 * `beijingClock` marks a partner whose scans DHLink relays on its own
 * Beijing clock rather than the scan's, and `hubClockPickup` one whose pickup
 * DHLink's node copies from the partner's first scan, on its hub's clock.
 * `scanZone` gives the clock of a partner's own scan DHLink copies, by its
 * place and wording, which wins over Beijing's.
 */
export const DHLINK_LAST_LEGS: readonly {
  readonly carrier: string; readonly number: RegExp; readonly valid?: (number: string) => boolean; readonly countries?: readonly string[];
  readonly beijingClock?: true; readonly hubClockPickup?: true;
  readonly scanZone?: (place: string, description: string) => string | null;
}[] = [
  // SwiftX's own numbers: SWX and eighteen digits, the layout `swiftx-1` claims. Its
  // relayed rounds and deliveries are recorded before a US reading of their clocks.
  { carrier: 'swiftx', number: /^SWX\d{18}$/, beijingClock: true },
  // GOFO's US waybills: GFUS and fourteen digits, the layout `gofo-1` claims. DHLink's own
  // rows of the line are on Beijing time. Its copies of GOFO's scans at a station GOFO
  // names, and of GOFO's label, keep GOFO's digits on GOFO's clock for them: read on Beijing
  // time they came 13 and 14 hours before GOFO's own. DHLink's pickup node gives GOFO's
  // arrival at its regional hub, the same clock and town as GOFO's own scan.
  { carrier: 'gofo', number: /^GFUS\d{14}$/, beijingClock: true, hubClockPickup: true,
    scanZone: (place, description) => gofoScanZone(place.split(',')[0] ?? '', description) },
  // DPD Switzerland's parcel numbers: fourteen digits from its depots 0600 to 0619.
  { carrier: 'dpd', number: /^06[01]\d{11}$/ },
  // USPS's package barcodes (IMpb) with their check digit, as LiBaoTongXu's US line gives the last leg.
  { carrier: 'usps', number: /^(?:9[1-5]\d{20}|9[2-4]\d{24})$/, valid: isValidUspsPackageBarcode },
  // YWE's numbers with their check digit, the layout `ywe-1` claims, as a line to the US gives the last leg.
  { carrier: 'ywe', number: /^YWE\d{14}$/, valid: hasGs1CheckDigitInDigits },
  // GOFO's Dutch waybills with their check digit, the layout `gofo-nl-1` claims, as a line to the Netherlands gives it.
  { carrier: 'gofo-nl', number: /^GFNL\d{14}$/, valid: isValidGofoEuropeWaybill },
  // Sameday's `1XL` and eleven digits, the layout `sameday-3` claims, as a line to Bulgaria gives it.
  { carrier: 'sameday', number: /^1XL\d{11}$/ },
  // Canada Post's sixteen-digit parcel PINs with their GS1 digit, a length other carriers share, on a parcel bound for Canada.
  { carrier: 'canada-post', number: /^\d{16}$/, valid: hasGs1CheckDigit, countries: ['CA'] },
];

/** A number DHLink's tracker can be asked for; anything else is not sent. */
export function normalizeDhlinkNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DHLink tracking numbers are 8 to 40 letters and digits');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `DHLink returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

function withoutPostcodes(value: string): string {
  return value.replace(STATE_ZIP, '$1').replace(POSTCODE, '').replace(/\s+/g, ' ').trim();
}

function wordingOf(info: string): string {
  return withoutPostcodes(info.replace(CONTACT, '')).replace(/[\s,，;；:：(（]+$/, '');
}

/** The words of a place part before the first one holding a digit: a postcode or a street number. */
function beforeDigits(part: string): string {
  const words = part.split(' ');
  const index = words.findIndex((word) => /\d/.test(word));
  return (index < 0 ? words : words.slice(0, index)).join(' ');
}

/**
 * Mainland China's airports with international cargo flights, by IATA code ("PVG"). A list rather than the
 * gazetteer, which the browser entry cannot load.
 */
const CHINA_AIRPORTS = new Set(['PVG', 'SHA', 'PEK', 'PKX', 'CAN', 'SZX', 'HGH', 'NGB', 'XMN', 'FOC', 'CTU', 'TFU', 'CKG', 'CGO',
  'TSN', 'WUH', 'NKG', 'TAO', 'TNA', 'SHE', 'DLC', 'CSX', 'KMG', 'XIY', 'HFE', 'NNG', 'URC', 'HRB', 'SJW', 'TYN', 'WNZ', 'YIW']);
const chinaAirport = (part: string): boolean => CHINA_AIRPORTS.has(part);

/**
 * A row's place without its postcode, placeholder or forwarder's name, and
 * whether it is in China. Feeds append the destination's code to Chinese places
 * ("广州市,GB", "SHENZHEN, US"), Chinese airports' codes too ("PVG, US"), and a
 * code alone names no place.
 */
function placeOf(raw: string): { location: string; china: boolean } {
  const parts = withoutPostcodes(raw).split(/[,;]/).map((part) => beforeDigits(part.trim()))
    .filter((part) => !PLACEHOLDERS.has(part.toLowerCase()) && !FORWARDER.test(part.toLowerCase().replace(/\s+/g, '')));
  const china = CJK.test(raw) || parts.some((part) => CHINA_NAMES.test(part.toLowerCase().replace(/\s+/g, '')) || chinaAirport(part));
  const kept = china ? parts.filter((part) => !COUNTRY.test(part)) : parts;
  return { location: kept.every((part) => COUNTRY.test(part)) ? '' : [...new Set(kept)].join(', '), china };
}

/** A stored row's place as the parser now reads it, or nothing for a placeholder or a country alone. */
export const dhlinkPlace = (raw: string): string => placeOf(raw).location;

interface Scan {
  stamp: string;
  event: CarrierEvent;
  /** Ranks the rows that share a clock: DHLink's node, English, a place, a stage, then the longer wording. */
  rank: readonly number[];
  /** A place in China. */
  china: boolean;
  /** The zone of the US state a post office's row names, unless the state spans several. */
  state: string | null;
  /** DHLink's node for the last-mile partner's pickup, naming the partner's US hub by its state. */
  hub: boolean;
  /** When DHLink recorded the row, or the read when it does not say. */
  recorded: number;
}

/** The instant DHLink recorded a row, on its Beijing clock; null when the reply does not say. */
function recordedAt(row: Record<string, unknown>): number | null {
  const wall = WALL_CLOCK.exec(text(row, 'createDate', 64));
  return wall ? isoTime(`${wall[1]}T${wall[2]}`, RECORD_ZONE)?.timestamp ?? null : null;
}

// The rows of Pactic, the Hungarian platform a line to south-eastern Europe goes through: its data record, the
// arrival at its hub in Hungary and the line haul from there, on Budapest's clock whatever the destination's.
const PACTIC_ROW = /^(?:data received; data transferred and received by carrier|arrived to hu hub|linehaul transit; parcel has entered the linehaul network)\b/i;
const PACTIC_ZONE = 'Europe/Budapest';

/**
 * The zone a scan's clock keeps, where DHLink's record shows it. Places in
 * China and every row of a parcel whose last leg relays on Beijing time keep
 * Beijing time, but a pickup that names a hub on the partner's clock. A US
 * post office's row, or that pickup, keeps its state's when the row was
 * recorded after that reading. A row recorded before its clock could have
 * struck at the destination, in any of its zones, keeps DHLink's own Beijing
 * time. Null when either clock could be the row's. A partner's own scan
 * outside China keeps the partner's clock (`partner`) when it has struck.
 */
function scanZone(scan: Scan, destination: string, beijingClock: boolean, partner: string | null): string | null {
  const fits = (zone: string) => {
    const time = isoTime(scan.stamp, zone);
    return time !== null && time.timestamp <= scan.recorded + CLOCK_SKEW_MS;
  };
  if (PACTIC_ROW.test(scan.event.description ?? '')) return fits(PACTIC_ZONE) ? PACTIC_ZONE : null;
  if (!scan.china && partner && fits(partner)) return partner;
  if (scan.china || beijingClock) return fits(RECORD_ZONE) ? RECORD_ZONE : null;
  if (scan.state && fits(scan.state)) return scan.state;
  const away = scan.state ? [scan.state] : countryZones(destination);
  return away.length && !away.includes(RECORD_ZONE) && !away.some(fits) && fits(RECORD_ZONE) ? RECORD_ZONE : null;
}

function projectRow(row: unknown, readAt: number): Scan | 'ahead' | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DHLink returned an invalid scan');
  const stamp = text(row, 'trackTime', 64);
  const wall = WALL_CLOCK.exec(stamp);
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  const earliest = local ? firstOccurrence(DateTime.fromISO(local, { zone: EARLIEST })) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!earliest?.isValid || earliest.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'DHLink returned an invalid scan time');
  // A row dated after the read is not a scan yet.
  if (earliest.toMillis() > readAt) return 'ahead';
  const info = text(row, 'info');
  // DHLink's nodes can end their wording with the row's own clock ("Shipment has delivered at …").
  const said = wordingOf(info);
  const description = said.endsWith(` at ${stamp}`) ? said.slice(0, -` at ${stamp}`.length).trim() : said;
  if (!description || FLIGHT_BOOKED.test(description)) return null;
  const code = text(row, 'nodeCode', 32);
  const name = text(row, 'nodeName', 64);
  const place = text(row, 'place', 200);
  const { location, china } = placeOf(place);
  const staged = dhlinkStage(code, name, description);
  // The clock is set once the scan's rows are pooled.
  const event: CarrierEvent = {
    description: dhlinkEnglish(description) ?? description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  const rank = [name ? 1 : 0, CJK.test(description) ? 0 : 1, location ? 1 : 0, staged ? 1 : 0, description.length];
  // USPS names the office in the place, or else at the end of its wording; the pickup node names the partner's hub.
  const hub = code === LAST_MILE_PICKUP ? (US_OFFICE.exec(place.toUpperCase()) ?? US_HUB.exec(place.toUpperCase()))?.[1] : undefined;
  const office = hub ?? (US_OFFICE.exec(place.toUpperCase()) ?? US_OFFICE.exec(info))?.[1];
  const state = office && !SPLIT_STATES.has(office) ? usStateTimeZone(office) : null;
  return { stamp: local, event, rank, china, state, hub: usStateTimeZone(hub) !== null,
    recorded: Math.min(recordedAt(row) ?? readAt, readAt) };
}

// The town and state a US partner can write before its wording ("Sampletown IL, "), as UniUni does.
const TOWN_FIRST = /^([A-Z][A-Za-z .'-]{0,40}) ([A-Z]{2}), /;

/** A relayed wording without the town and state a US partner can write before it. */
function unplaced(description: string | undefined): string {
  return (description ?? '').replace(TOWN_FIRST, '');
}

/**
 * A relayed wording without the town and state before it when the row's place
 * starts with them too, so the place alone names them.
 */
export function dhlinkWithoutTown(description: string, location: string): string {
  const town = TOWN_FIRST.exec(description);
  if (!town || description.length === town[0].length) return description;
  return location.trim().toLowerCase().startsWith(`${town[1]} ${town[2]}`.toLowerCase()) ? description.slice(town[0].length) : description;
}

function copyPlace(event: CarrierEvent): string {
  const town = TOWN_FIRST.exec(event.description ?? '');
  return (event.location || (town ? town[1] + ' ' + town[2] : '')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// A US place's state, before the country if any ("Sampleville, IL, US", "SAMPLEVILLE, IL").
const PLACE_STATE = /,\s*([A-Z]{2})(?:\s*,\s*US)?$/;

/** Whether two scans' places name different US states. */
function otherStates(left: CarrierEvent, right: CarrierEvent): boolean {
  const state = (event: CarrierEvent) => {
    const named = PLACE_STATE.exec((event.location ?? '').toUpperCase())?.[1];
    return usStateTimeZone(named) ? named : undefined;
  };
  const [one, two] = [state(left), state(right)];
  return !!one && !!two && one !== two;
}

function compatiblePlaces(left: string, right: string): boolean {
  return !left || !right || left === right;
}

function outranks(left: readonly number[], right: readonly number[]): boolean {
  const index = left.findIndex((value, position) => value !== right[position]);
  return index >= 0 && left[index]! > right[index]!;
}

/** The delivery a relayed USPS round promises on its scan's day. */
function roundDelivery(event: CarrierEvent): string | null {
  return typeof event.time === 'string' ? uspsRoundDelivery(event.description ?? '', event.time.slice(0, 10)) : null;
}

type Leg = { leg: (typeof DHLINK_LAST_LEGS)[number]; number: string };

/** The parcel's destination country; DHLink writes Britain's code as UK. */
function destinationOf(entry: Record<string, unknown>): string {
  const code = text(entry, 'destCountryCode', 8).toUpperCase();
  return code === 'UK' ? 'GB' : code;
}

/** The partner whose layout the whole number has, for a parcel bound there. */
function legOf(number: string, destination: string): Leg | null {
  const leg = number ? DHLINK_LAST_LEGS.find((candidate) => candidate.number.test(number) && (candidate.valid?.(number) ?? true)
    && (candidate.countries?.includes(destination) ?? true)) : undefined;
  return leg ? { leg, number } : null;
}

/** The last leg, when its number's whole layout is one the table maps. */
function lastLeg(entry: Record<string, unknown>): Leg | null {
  return legOf(normalizeTrackingNumber(text(entry, 'lastTurnNo', 64)), destinationOf(entry));
}

/**
 * The partner that delivers the parcel, under the last leg's number, which can be the number
 * asked. A parcel with none can carry the partner's own number as its tracking number, as
 * SwiftX's do: DHLink relays them under it.
 */
function partnerOf(entry: Record<string, unknown>, tracking: string): Leg | null {
  return text(entry, 'lastTurnNo', 64) ? lastLeg(entry) : legOf(tracking, destinationOf(entry));
}

/**
 * DHLink lists the parcel, under the number asked, without a scan: it holds the order, with its
 * last leg once the line has one, before its warehouse receives the parcel. It still counts the
 * parcel not found, but the number is known.
 */
function listedWithoutScans(entry: Record<string, unknown>, tracking: string): NoHistoryError {
  const partner = partnerOf(entry, tracking);
  return new NoHistoryError(PROVIDER, 'DHLink lists the parcel without scans', { reason: 'listed',
    ...(partner ? { deliveryCarrier: partner.leg.carrier, deliveryTrackingNumber: partner.number } : {}) });
}

/**
 * The reply of `POST /stage-api/trbiz/track/queryTrack` for one number. The
 * search finds a parcel by its tracking number, and by other numbers of the
 * parcel too, so the parcel counts only when the number asked is its tracking
 * number or its DHLink number. Each scan comes once per feed that relays it,
 * in English or Chinese and sometimes in two formats: the rows that share a
 * clock are one scan. The order id, the feeds' ids and the row ids are not read.
 */
export function parseDhlink(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeDhlinkNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'DHLink returned an invalid envelope');
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, 'DHLink did not complete the lookup');
  const list = isRecord(payload.data) ? payload.data.trackList : undefined;
  if (!Array.isArray(list) || list.length !== 1 || !isRecord(list[0])) throw new SchemaError(PROVIDER, 'DHLink returned an invalid parcel list');
  const entry = list[0];
  const tracking = normalizeTrackingNumber(text(entry, 'trackno', 64));
  const own = normalizeTrackingNumber(text(entry, 'logisticsNo', 64));
  const rows = entry.trackinfoList;
  const noRows = rows === null || rows === undefined || (Array.isArray(rows) && !rows.length);
  // The tracker answers a number it does not know with an empty parcel and counts it not found.
  if (entry.state === STATE_NOT_FOUND && !tracking && !own && noRows) {
    // It answers a parcel's DHLink number the same way when the parcel has another tracking
    // number, and its last leg's number always: for those layouts the answer settles nothing,
    // but the reason tells it from an outage.
    if (DHLINK_NUMBER.test(number)) {
      throw new IndeterminateError(PROVIDER, 'DHLink finds a parcel by its DHLink number only when that is its tracking number', { reason: 'portal_not_found' });
    }
    if (DHLINK_LAST_LEGS.some((leg) => leg.number.test(number))) {
      throw new IndeterminateError(PROVIDER, 'DHLink does not find a parcel by the number of its last leg', { reason: 'portal_not_found' });
    }
    throw new NotFoundError(PROVIDER);
  }
  if (tracking !== number && own !== number) throw new IndeterminateError(PROVIDER, 'DHLink answered with another parcel');
  if (noRows) throw listedWithoutScans(entry, tracking);
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'DHLink returned a parcel without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DHLink returned an oversized history');

  const scans = new Map<string, Scan>();
  let ahead = false;
  for (const row of rows) {
    const scan = projectRow(row, readAt);
    if (scan === 'ahead') ahead = true;
    if (!scan || scan === 'ahead') continue;
    const held = scans.get(scan.stamp);
    // The rows of one scan pool what they show of its clock: a place, and the earliest record.
    const kept = !held || outranks(scan.rank, held.rank) ? scan : held;
    scans.set(scan.stamp, held ? { ...kept, china: held.china || scan.china, state: held.state ?? scan.state,
      hub: held.hub || scan.hub, recorded: Math.min(held.recorded, scan.recorded) } : kept);
  }
  const destination = destinationOf(entry);
  const last = lastLeg(entry);
  // A parcel whose tracking number is the partner's own keeps the clock a parcel with no known last leg has.
  const partner = partnerOf(entry, tracking);
  // Newest first, as the tracking page lists them; the clocks sort as written.
  const dated = [...scans.values()].sort((left, right) => (left.stamp < right.stamp ? 1 : left.stamp > right.stamp ? -1 : 0))
    .map((scan) => {
      const partner = last?.leg.scanZone?.(scan.event.location ?? '', scan.event.description ?? '') ?? null;
      const zone = scanZone(scan, destination, last?.leg.beijingClock === true && !(scan.hub && last.leg.hubClockPickup), partner);
      return { scan, place: copyPlace(scan.event), zone, time: zone ? isoTime(scan.stamp, zone) : null,
        station: partner !== null && zone === partner && !!scan.event.location };
    });
  // The partner's scans DHLink copies without a place ("Loaded on Vehicle"), after the first that
  // names the partner's station, are on the clock of the station row nearest them.
  const stations = dated.filter((entry) => entry.station);
  for (const entry of stations.length ? dated : []) {
    if (entry.station || entry.scan.event.location || entry.scan.china || entry.scan.stamp <= stations.at(-1)!.scan.stamp) continue;
    const gap = (other: (typeof dated)[number]) => Math.abs(Date.parse(`${other.scan.stamp}Z`) - Date.parse(`${entry.scan.stamp}Z`));
    const zone = stations.reduce((near, other) => (gap(other) < gap(near) ? other : near)).zone!;
    const time = isoTime(entry.scan.stamp, zone);
    if (time && time.timestamp <= entry.scan.recorded + CLOCK_SKEW_MS) Object.assign(entry, { zone, time });
  }
  // A US partner's scan can come twice, as UniUni's do: on its hub's wall clock, often after the
  // hub's town, and on UTC. The UTC copy's clock is the other's on a US reading, to the second,
  // before DHLink recorded either: one scan, on that US clock.
  const copies = new Set<(typeof dated)[number]>();
  if (destination === 'US') {
    const rows = dated.map(entry => ({
      entry, wording: unplaced(entry.scan.event.description), utc: Date.parse(entry.scan.stamp + 'Z'),
      readings: usClockReadings(entry.scan.stamp, entry.scan.state),
    }));
    // The source already has one row per wall stamp. Lookup by UTC instant and check its wording and place.
    const utcRows = new Map(rows.map(row => [row.utc, row]));
    for (const local of rows) {
      if (copies.has(local.entry)) continue;
      for (const { zone, time } of local.readings) {
        const copy = utcRows.get(time.timestamp);
        if (!copy || copy.wording !== local.wording || copies.has(copy.entry)
          || !compatiblePlaces(local.entry.place, copy.entry.place)
          || copy.utc > Math.min(local.entry.scan.recorded, copy.entry.scan.recorded) + CLOCK_SKEW_MS) continue;
        Object.assign(local.entry, { zone, time });
        copies.add(copy.entry);
        break;
      }
    }
    // A Beijing-timed record can also have a copy on a partner's US clock.
    const recorded = new Map<string, typeof dated>();
    const key = (event: CarrierEvent, instant: number) => JSON.stringify([event.description, instant]);
    for (const entry of dated) {
      if (!entry.time || !(last?.leg.beijingClock || entry.zone === RECORD_ZONE)) continue;
      const id = key(entry.scan.event, entry.time.timestamp);
      const group = recorded.get(id) ?? [];
      group.push(entry);
      recorded.set(id, group);
    }
    // SwiftX's copy can name its town where DHLink's row names the hub, but a scan in another
    // state is another scan, whatever its wording and clock.
    for (const { entry, readings } of rows) {
      if (readings.some(({ time }) => recorded.get(key(entry.scan.event, time.timestamp))
        ?.some(other => other !== entry && !otherStates(other.scan.event, entry.scan.event)))) copies.add(entry);
    }
  }
  // A place naming only the destination country is the parcel's, not the scan's: a Canada line's
  // airline hand-over in China reads "Canada".
  const kept = dated.filter((entry) => !copies.has(entry));
  const events = kept
    .map(({ scan, time }): CarrierEvent => {
      const { location, ...event } = scan.event;
      const placed = location && !(destination && countryCode(location) === destination) ? { location } : {};
      return { ...(time ? { time: time.iso } : { local_time: scan.stamp }), ...event,
        ...(event.description ? { description: dhlinkWithoutTown(event.description, location ?? '') } : {}), ...placed };
    });
  // Rows dated after the read may be scans DHLink wrote early; otherwise only notices came, such as a booked flight.
  if (!events.length && !ahead) throw listedWithoutScans(entry, tracking);
  if (!events.length) throw new IndeterminateError(PROVIDER, 'DHLink has no scans for the parcel yet');
  // A receipt after DHLink moved the parcel on, at another warehouse or the post a line hands it
  // to, takes the parcel along its way: no step back.
  let moved = false;
  for (const event of [...events].reverse()) {
    if (event.stage === 'accepted' && moved) Object.assign(event, { stage: 'in_transit', stage_source: 'carrier_map' });
    else if (event.stage && MOVED.has(event.stage)) moved = true;
  }
  // A pending delivery after the last-mile partner's own scans is that partner's round.
  events.forEach((event, index) => {
    if (event.provider_code === PENDING_DELIVERY && dhlinkRound(events.slice(index + 1))) {
      Object.assign(event, { stage: 'out_for_delivery', stage_source: 'carrier_map' });
    }
  });

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  let stage = current?.stage as Stage | undefined;
  let source = current?.stage_source;
  // DHLink counts the parcel delivered even when the last feed's wording says less,
  // unless rows were written ahead of the read: then the count may be too.
  if (entry.state === STATE_DELIVERED && !ahead && stage !== 'delivered' && stage !== 'returned') {
    stage = 'delivered';
    source = 'carrier_map';
  }
  // The round the parcel is on, when it is the current scan and is read on the destination's clock.
  const round = stage === 'out_for_delivery' && current?.stage === 'out_for_delivery'
    && ![null, RECORD_ZONE].includes(kept[events.indexOf(current)]!.zone) ? roundDelivery(current) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: round,
    ...(stage === 'delivered' && newest.stage === 'delivered' && newest.time ? { delivered_at: newest.time } : {}),
    ...(partner ? { delivery_carrier: partner.leg.carrier, delivery_tracking_number: partner.number } : {}),
    ...(COUNTRY.test(destination) ? { destination_country: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
