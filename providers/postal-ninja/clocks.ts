/**
 * The clocks of Postal Ninja's services, by the name it gives each scan's
 * service (`ds`). Its `dt` names no zone, and it is not always the scanning
 * office's wall clock: Postal Ninja keeps some services in UTC and others in
 * their home zone wherever the scan happened. Each entry was established on
 * benchmark parcels against the carrier's own instants (its adapter's offsets
 * or epoch times, or its website); README.md gives the evidence. A service
 * missing here has no known clock: its scans borrow a zone in the adapter, as
 * a guess, or keep their wall time.
 */
import { CAINIAO_CHINA_ZONE, cainiaoInChina } from '../../carriers/aliexpress/clock.js';
import { royalMailLabelsPartners, royalMailPartnerWall } from '../../carriers/royal-mail/clock.js';
import { POSTNL_ACCEPTANCE_STAMP, POSTNL_CUSTOMS_STAMP } from '../../carriers/spring-gds/clock.js';
import { swissPostDestinationZone } from '../../carriers/swiss-post/clock.js';
import { uspsScanZone } from '../../carriers/usps/clock.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { DateTime } from 'luxon';
import {
  canadaProvinceTimeZone, countryCode, countryTimeZone, firstOccurrence, postalOfficeZone, sharedClockZone, usStateTimeZone,
} from '../../core/time/index.js';
import type { ZoneBasis } from '../../places/clocks.js';
import { keepsZone } from '../../places/zones.js';
import { courierZone } from '../shared/hints.js';

/** Services whose every scan is at one clock, wherever it happened and whatever other services the history names. */
const FIXED_CLOCKS: ReadonlyMap<string, string> = new Map([
  ['Austrian Post', 'UTC'],
  ['Intelcom', 'UTC'],
  ['OnTrac', 'UTC'],
  ['Poste Italiane', 'UTC'],
  ['Raben', 'UTC'],
  // Also for their scans abroad: Singapore Post's in China. Swiss Post's own are in
  // Switzerland; the destination post's it relays keep their office's clock (serviceZone).
  // Australia Post's scans in the UK on an item from there came eleven hours after the instants
  // Australia Post's tracker gives them, on Sydney's daylight clock.
  ['Australia Post', 'Australia/Sydney'],
  ['Singapore Post', 'Asia/Singapore'],
  ['Swiss Post', 'Europe/Zurich'],
  // A Chinese forwarder relaying in Chinese and English: its copy of GOFO France's "being
  // prepared by the sender" is GOFO's own instant at Beijing's wall clock, to the second.
  ['Zhongzhou Logistics', 'Asia/Shanghai'],
]);

/**
 * Services on Beijing's clock in a history another service names: DHLink records
 * every scan of a parcel GOFO delivers on Beijing time, as its own tracker does.
 */
const BEIJING_BESIDE: ReadonlyMap<string, string> = new Map([['DHLink', 'GOFO Express']]);

/**
 * Posts that date their own scans in UTC and keep the origin post's, which
 * they receive by EDI and mark outbound, at that office's wall clock, as
 * their own trackers do: Correos de El Salvador's arrival in San Salvador at
 * 21:30:17 is UPU's 15:30 local, and its copy of Swiss Post's departure from
 * Geneva keeps Geneva's 12:20.
 */
const UTC_POSTS: ReadonlySet<string> = new Set(['Correos de El Salvador']);
/** The origin post's scans, as Postal Ninja translates "(salida)" and "(recibido por EDI)". */
const OUTBOUND = /\((?:outbound|output|departure|received by EDI)\)$/i;

/**
 * Carriers whose scans Postal Ninja writes with a UTC suffix on the scanning
 * office's wall clock: Russian Post's acceptance and delivery came at the
 * digits ParcelsApp dates at +03:00 and +07:00. Russia keeps several clocks
 * and the reply names none of them, so the scans are read like those of a
 * service whose clock is unknown.
 */
const SUFFIXED_WALL_CLOCKS: ReadonlySet<string> = new Set(['russian-post']);
/** A UTC suffix on a `dt`. */
const UTC_SUFFIX = /(?:Z|[+-]00:?00)$/i;

/**
 * DHL Germany's scans: their `dt` is the office's wall clock read on Berlin's
 * and written in UTC, wherever the office is. Royal Mail's customs scans in
 * Milan at 00:01 and 23:06 came at 22:01 and 21:06, its departure from Belfast
 * at 00:11 British summer time at 22:11, Swiss Post's posting at 10:05 Zurich
 * time at 08:05; an Australian office's departure and DHL's own scans in
 * Germany, read on Berlin's clock, came an hour early. A copy of the postal
 * union's records names its office by UPU code.
 */
const BERLIN_UTC_COPIES = 'DHL Germany';
const BERLIN = 'Europe/Berlin';

/**
 * Spring GDS's scans, which are PostNL's feed (carriers/spring-gds/adapter.ts). Postal Ninja gives
 * their `dt` as the feed has it: the scan's local time for most, and UTC for the label's creation
 * and the processing record without a country (`postnlRecordZone`), which name no place and keep
 * PostNL's wording. Spring GDS's sorting at 14:18 Dutch time came at 14:18, beside the copies at
 * 15:18 Postal Ninja made before, when it read the feed's local times as UTC and showed them on
 * Amsterdam's clock. It keeps those former copies beside the new ones (`formerCopies`).
 */
const SPRING_GDS = 'Spring GDS';
/**
 * On a Spring GDS item Postal Ninja also names PostNL's scans from that feed "PostNL", at the feed's
 * digits alike: the pre-advice at 15:49 Dutch time came at 15:49. The stamps the feed dates in UTC
 * to the fraction of a second, customs' and the acceptance centre's, come with their UTC digits and
 * seconds, as ParcelsApp gives them: the acceptance at 07:53:24Z came at 07:53:24. An acceptance
 * dated to the minute is a local scan.
 */
const POSTNL = 'PostNL';
const AMSTERDAM = 'Europe/Amsterdam';
const TO_THE_MINUTE = /T\d{2}:\d{2}(?::00(?:\.0+)?)?$/;
const POSTNL_UTC_RECORDS = /^(?:the shipping label has been created|the item is being processed)[.!]?$/i;

/**
 * Royal Mail's scans on an item bound for Australia or the United States, once its scan leaving
 * the UK has come: they are the destination post's, whose office's wall clock Royal Mail labels
 * with one offset for the country wherever the office is (carriers/royal-mail/clock.ts), and
 * Postal Ninja gives that labelled instant on the UK's clock. Royal Mail's "Item Received" at
 * 00:34 was Australia Post's arrival at customs at 10:04 Sydney summer time, 09:04:25 under
 * Australia Post's own +10:00.
 */
const ROYAL_MAIL = 'Royal Mail';
const ROYAL_MAIL_SHOWN = 'Europe/London';
const LEAVING_THE_UK = /^item leaving the uk\b/i;

/** The destination a Royal Mail scan leaves the UK for, when that country's offices have Royal Mail's one label. */
export const royalMailLeavesFor = (service: string, description: string, destination: string | null): string | null =>
  service === ROYAL_MAIL && royalMailLabelsPartners(destination) && LEAVING_THE_UK.test(description.trim()) ? destination : null;

/**
 * The destination office's wall clock of a Royal Mail scan after it left the UK for `leftFor`,
 * back under Royal Mail's label. Those countries keep several clocks, so it keeps that wall clock.
 * Null for any other scan.
 */
export function royalMailPartnerScanWall(service: string, dt: string, leftFor: string | null): string | null {
  if (service !== ROYAL_MAIL || !leftFor) return null;
  return royalMailPartnerWall(leftFor, firstOccurrence(DateTime.fromISO(dt, { zone: ROYAL_MAIL_SHOWN })));
}

/** The zone of the office a scan of DHL Germany's copies names by UPU code. */
function berlinCopyZone(service: string, location: string): string | null {
  return service === BERLIN_UTC_COPIES ? postalOfficeZone(location) : null;
}

/** Whether a scan of Spring GDS's feed through Postal Ninja is one the feed dates in UTC. */
function feedUtcStamp(service: string, dt: string, location: string, description: string): boolean {
  const wording = description.trim();
  if (!location.trim() && POSTNL_UTC_RECORDS.test(wording)) return true;
  return service === POSTNL && (POSTNL_CUSTOMS_STAMP.test(wording) || (POSTNL_ACCEPTANCE_STAMP.test(wording) && !TO_THE_MINUTE.test(dt)));
}

/** Whether a service's scans are Spring GDS's feed at its digits on a lookup for `carrier`. */
const feedCopy = (service: string, carrier: string | null) => service === SPRING_GDS || (service === POSTNL && carrier === 'spring-gds');

/**
 * A scan's `dt` as its service's wall clock: without the UTC suffix Postal
 * Ninja writes on some, DHL Germany's back on Berlin's clock; the `dt` itself
 * otherwise. A scan of Spring GDS's feed that the feed dates in UTC is its UTC
 * instant instead.
 */
export function wallClock(service: string, dt: string, location = '', description = '', carrier: string | null = null): string {
  if (service === BERLIN_UTC_COPIES) {
    const written = DateTime.fromISO(dt, { zone: 'UTC' });
    if (written.isValid) return written.setZone(BERLIN).toFormat("yyyy-MM-dd'T'HH:mm:ss");
  }
  if (feedCopy(service, carrier) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(dt) && feedUtcStamp(service, dt, location, description)) return `${dt}Z`;
  return SUFFIXED_WALL_CLOCKS.has(carrierIdFromName(service) ?? '') ? dt.replace(UTC_SUFFIX, '') : dt;
}

/**
 * The indexes of Postal Ninja's former copies of Spring GDS's local scans: a scan to the minute
 * whose service also gives its wording at the feed's digits, its `dt` read on Amsterdam's clock and
 * written back in UTC, an hour earlier in winter and two in summer.
 */
export function formerCopies(scans: readonly { service: string; dt: string; description: string }[], carrier: string | null): Set<number> {
  const key = (service: string, minute: string, description: string) => `${service}\n${minute}\n${description.trim().toLowerCase()}`;
  const minuteScans = scans.map((scan, index) => ({ ...scan, index }))
    .filter((scan) => feedCopy(scan.service, carrier) && TO_THE_MINUTE.test(scan.dt));
  const given = new Set(minuteScans.map((scan) => key(scan.service, scan.dt.slice(0, 16), scan.description)));
  const former = new Set<number>();
  for (const scan of minuteScans) {
    const feed = firstOccurrence(DateTime.fromISO(scan.dt, { zone: AMSTERDAM })).toUTC();
    if (feed.isValid && given.has(key(scan.service, feed.toFormat("yyyy-MM-dd'T'HH:mm"), scan.description))) former.add(scan.index);
  }
  return former;
}

/**
 * Cainiao, whose scans keep its feed's wall clock, each at its site's: its
 * steps in China on China's clock (`cainiaoInChina`), the others on the
 * transit hub's or the destination's, which vary by parcel. Against
 * Cainiao's own offsets on two parcels to the UK and France, every scan had
 * the feed's digits.
 */
const CAINIAO = 'Cainiao';

/**
 * 4PX, whose scans in China Postal Ninja gives in UTC: its pickup at 21:08:31 on 4PX's own
 * +08:00 came at 13:08:31. They are placed by the country their location names, in any
 * history; its scans that name no place borrow from them, and those elsewhere have no
 * established clock.
 */
const FOUR_PX = '4PX Express';

/** Services with one clock per network, by the parcel's destination: GOFO's US network keeps Los Angeles time in New York. */
const NETWORK_CLOCKS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ['GOFO Express', new Map([['US', 'America/Los_Angeles'], ['FR', 'Europe/Paris']])],
]);

/**
 * Services that date a scan at the scanning office's wall clock. Beside other
 * services they can relay a scan at another clock (PostNord gives PostNL's
 * Dutch scans four hours ahead), so they are placed only in a history they
 * report alone within one country.
 */
const LOCAL_CLOCKS: ReadonlySet<string> = new Set([
  'An Post Ireland', 'CTT Express', 'Correos de España', 'DHL Parcel Netherlands', 'DPD', 'DPD Poland', 'DPD UK', 'GLS',
  'Hermes Germany', 'MRW', 'Nova Poshta', 'Packeta', 'Poczta Polska', 'PostNord', 'Posten Norge', 'UkrPoshta',
]);

/**
 * Services on the scanning office's clock across zones, which only the scan's
 * location names: placed by it in a history they report alone. A US state or
 * Canadian province with several zones is read in its majority zone, as Ship24
 * and ParcelsApp read theirs.
 */
const LOCATED_CLOCKS: ReadonlySet<string> = new Set(['FedEx', 'UPS']);
/**
 * Services whose scans between midnight and 1 a.m. reach Postal Ninja twelve
 * hours late: UPS's arrival in Lenexa at 00:25 is dated 12:25. A scan they
 * date 12:xx may be either, except a delivery, which is read as afternoon.
 */
const TWELVE_HOUR_CLOCKS: ReadonlySet<string> = new Set(['UPS']);

/**
 * USPS, whose scans keep the scanning facility's wall clock in any history,
 * as USPS's own tracker gives them: on spring GDS items, its scans at
 * California facilities came at their Pacific digits. Each is placed by the
 * state its location names, as USPS's adapter reads it; one that names none
 * borrows from the others.
 */
const isUsps = (service: string) => carrierIdFromName(service) === 'usps';

// The territories USPS delivers in as at home, each on a clock of its own: Puerto Rico, the US Virgin Islands,
// Guam, American Samoa and the Northern Mariana Islands.
const US_TERRITORY_ZONES: ReadonlySet<string> = new Set(['PR', 'VI', 'GU', 'AS', 'MP'].map((code) => usStateTimeZone(code)!));

/**
 * Whether a scan of the service may borrow the zone routing passes for the
 * parcel's carrier: a USPS scan borrows no zone of a country outside the US
 * and its territories, such as the Amsterdam zone of a spring GDS item, which
 * put its scans eight and nine hours early. It keeps its wall time instead.
 */
export function borrowsRoutingZone(service: string, zone: string): boolean {
  return !isUsps(service) || keepsZone('US', zone) || US_TERRITORY_ZONES.has(zone);
}

/** A scan dated without a time is written as midnight (FedEx's pickup, Geodis's departure). */
const MIDNIGHT = /T00:00(?::00)?$/;
const POSTAL_CODE = /^(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/i;

/** What the reply says about where the parcel's scans happened. */
export interface Journey {
  number: string;
  /** The parcel's destination country (`track.destCn`). */
  destination: string | null;
  /** Whether one service reports the full history and, for a postal item, its origin is its destination. */
  alone: boolean;
  /** The zone routing passes for the parcel's carrier, else `carrierHomeZone`'s. */
  fallback: string | null;
  /** The services that reported the reply's scans. */
  services?: ReadonlySet<string>;
}

/**
 * The zone of the one country a catalog carrier serves (BRT's Italy), for a
 * carrier whose catalog zone is the UTC placeholder. Only scans of a service
 * with a local clock are read in it: a carrier's home is no clock for the
 * services Postal Ninja keeps in UTC (Poste Italiane), nor for the
 * cross-border consolidators the catalog files under China. Null for a
 * carrier serving several countries or none, and for unknown ids.
 */
export function carrierHomeZone(carrier: string | null): string | null {
  const definition = carrier && Object.hasOwn(CARRIER_DEFINITIONS, carrier)
    ? CARRIER_DEFINITIONS[carrier as keyof typeof CARRIER_DEFINITIONS] : undefined;
  const countries = definition?.countries ?? [];
  return countries.length === 1 ? countryTimeZone(countries[0]) : null;
}

const locationParts = (location: string): string[] =>
  location.split(',').map((part) => part.trim()).filter((part) => part && !POSTAL_CODE.test(part));

/**
 * The country a scan location ends with, after its town ("…, China"). A two-letter one
 * other than the US's could be a state ("Chicago, IL"), so it names none.
 */
function locationCountry(parts: readonly string[]): string | null {
  const last = parts.at(-1) ?? '';
  return parts.length > 1 && (last.length > 2 || /^us$/i.test(last)) ? countryCode(last) : null;
}

/**
 * The clock of a scan location that ends with its country: a US state or
 * Canadian province before it ("Atlanta, GA, United States", "TACOMA, WA,
 * 12345, United States"), or a country with one clock. A two-letter country
 * other than the US's could be a state ("Chicago, IL"), so it names none.
 */
function locationZone(location: string): string | null {
  const parts = locationParts(location);
  const country = locationCountry(parts);
  if (country === 'US') return parts.length === 3 ? usStateTimeZone(parts[1]) : null;
  if (country === 'CA') return parts.length === 3 ? canadaProvinceTimeZone(parts[1]) : null;
  return countryTimeZone(country);
}

/** A scan as the reply gives it. */
export interface Scan {
  /** Postal Ninja's name for the service that reported it (`ds`). */
  service: string;
  description: string;
  /** Its `dt`, without a zone. */
  wall: string;
  location: string;
  delivered: boolean;
}

/** A zone and how it was chosen, as a deduced instant names them (`time_zone`, `time_zone_basis`). */
export interface Zoned { zone: string; basis: ZoneBasis }

/**
 * Whether a scan is on its origin's clock, apart from its service's others: a
 * UTC post's copy of the origin post's, on the origin office's clock, or
 * Cainiao's step in China. It borrows a zone only from such scans and lends
 * none to the rest.
 */
export function originLeg({ service, description }: Pick<Scan, 'service' | 'description'>): boolean {
  return UTC_POSTS.has(service) ? OUTBOUND.test(description) : service === CAINIAO && cainiaoInChina(description);
}

/**
 * The established zone of a scan's wall time, from the service that reported
 * it: the destination post's clock for a scan Swiss Post relays from it, the
 * office's for DHL Germany's copies that name one, a UTC
 * post's or the origin's that an S10 suffix names for its copies, its fixed
 * or network clock in any history (Beijing's for DHLink's beside GOFO's), China's for Cainiao's steps in China, the
 * facility's for USPS's scans that name its state, else
 * in a history it reports alone its location's clock, or a local clock's
 * country: the destination's, else the service's (`courierZone`) or the
 * carrier's. A destination on another clock than the service's may be a
 * parcel that crossed a border, so it establishes none. Null when the clock
 * is unknown; false when the hour is (a date written as midnight, UPS's
 * 12:xx), so that no zone can place the scan. The zone comes with how it was
 * chosen (`time_zone_basis`).
 */
export function serviceZone(scan: Scan, journey: Journey): Zoned | null | false {
  const { service, description, wall, location, delivered } = scan;
  const at = (zone: string | null | undefined, basis: ZoneBasis): Zoned | null => zone ? { zone, basis } : null;
  const relayed = service === 'Swiss Post' ? at(swissPostDestinationZone(description, location, journey.destination), 'destination')
    : at(berlinCopyZone(service, location), 'carrier');
  if (relayed) return relayed;
  if (UTC_POSTS.has(service)) {
    if (!originLeg(scan)) return at('UTC', 'carrier');
    return isValidS10TrackingNumber(journey.number) ? at(countryTimeZone(journey.number.slice(-2)), 'carrier') : null;
  }
  const beside = BEIJING_BESIDE.get(service);
  const fixed = at(FIXED_CLOCKS.get(service), 'carrier')
    ?? at(beside && journey.services?.has(beside) ? 'Asia/Shanghai' : undefined, 'carrier')
    ?? at(journey.destination ? NETWORK_CLOCKS.get(service)?.get(journey.destination) : undefined, 'destination');
  if (fixed) return fixed;
  if (MIDNIGHT.test(wall) || (TWELVE_HOUR_CLOCKS.has(service) && wall.slice(11, 13) === '12' && !delivered)) return false;
  if (service === CAINIAO && originLeg(scan)) return at(CAINIAO_CHINA_ZONE, 'carrier');
  if (service === FOUR_PX && locationCountry(locationParts(location)) === 'CN') return at('UTC', 'carrier');
  if (isUsps(service)) return at(uspsScanZone(location) ?? locationZone(location), 'place');
  if (!journey.alone) return null;
  if (LOCATED_CLOCKS.has(service)) return at(locationZone(location), 'place');
  if (!LOCAL_CLOCKS.has(service)) return null;
  const home = courierZone(service, journey.number, wall) ?? journey.fallback;
  if (!journey.destination) return at(home, 'carrier');
  const destination = countryTimeZone(journey.destination);
  return destination && (!home || sharedClockZone([destination, home], wall)) ? at(destination, 'destination') : null;
}
