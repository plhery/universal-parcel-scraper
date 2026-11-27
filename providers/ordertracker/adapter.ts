import type { AdapterFactory } from '../../core/adapter/index.js';
import { IndeterminateError, NoHistoryError, SchemaError, STILL_READING } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { paused } from '../../core/runner/pause.js';
import { countryCode } from '../../core/time/index.js';
import { fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { USPS_FACILITY_KIND } from '../../carriers/usps/clock.js';
import { classifyEvent, event, eventStage, localEvent, numberOf, place, result, text } from '../shared/result.js';
import { ordertrackerFeeds, type OrdertrackerFeed } from './feeds.js';

const SOURCE = 'Ordertracker';
export const ORDERTRACKER_API = 'https://api.ordertracker.com/public/mobile-tracking/data';
export const ORDERTRACKER_BUDGET_MS = 50_000;
/**
 * How long Ordertracker reads the carriers for a number it has no copy of, at most: its "No
 * information" for a number they don't know comes after 45 s. A request that hangs up does not
 * stop the read, and until the read ends a second ask gets that same "No information" at once.
 */
export const ORDERTRACKER_READ_MS = 47_000;
/** The time kept for the ask that follows a wait for the read's end: it answers from Ordertracker's copy. */
const COLLECT_MS = 2_000;
/** The header Ordertracker's Android app sends with every lookup, the same for every install. */
const MOBILE_SECRET = 'pr?GGSV}XRkVz>{/~v3~("s"&KJ`FP>J'; // gitleaks:allow
const MAX_EVENTS = 500;
const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})Z$/;
// A dated wall clock's offset east of Greenwich.
const EAST_OF_GREENWICH = /\+(?!00:00)\d{2}:\d{2}$/;
const COUNTRY_TAIL = /(?:^|,\s?)([A-Z]{2})$/;

const pageOf = (number: string) => `https://www.ordertracker.com/track/${encodeURIComponent(number)}`;

// A line naming a place alone: "Charlotte, NC", "MISSISSAUGA, ON, Canada", "CHICAGO,USA",
// "USA", a USPS facility or a UPU office code ("CAYTOA").
const PLACE_LINES = [
  /^[^,]+,\s?[A-Z]{2}(?:,\s?(?:[A-Z]{2,3}|USA|Canada))?$/,
  /^(?:[^,]+,\s?)?(?:USA|Canada)$/,
  new RegExp(String.raw`^[A-Z][A-Z .'-]*\s[A-Z]{2}\s*${USPS_FACILITY_KIND}$`),
  /^[A-Z]{2}[A-Z]{3}[A-Z0-9]$/,
];
const BRACKETED = /^(?:【([^【】]{1,80})】|\[([^[\]]{1,80})\])$/u;
// FedEx's wording, then the town in capitals (or one capitalised word) and the country code, then any detail:
// "Arrived at FedEx location EXAMPLE CITY US", "Delivered Example US Left at front door."
const CAPITAL_WORD = String.raw`(?!FedEx\b)\p{Lu}[\p{Lu}.'’-]*`;
const TRAILING_CAPITALS = new RegExp(String.raw`^(.+?) (${CAPITAL_WORD}(?: ${CAPITAL_WORD}){0,3}) ([A-Z]{2})(?: (.+))?$`, 'u');
const TRAILING_WORD = /^(.+?) ((?!FedEx\b)\p{Lu}[\p{Ll}.'’-]+) ([A-Z]{2})(?: (.+))?$/u;
const TRAILING_COUNTRY = /^(.+) ([A-Z]{2})$/;

interface Scan { wording: string; location: string }

/**
 * Ordertracker's answer for a number no feed knows: no carrier, and a notice asking to try again
 * later. It gives the same answer while it still reads the carriers for a request that hung up.
 */
function noInformation(payload: unknown): boolean {
  return isRecord(payload) && isRecord(payload.status) && payload.status.code === 'unknown'
    && Array.isArray(payload.carriers) && !payload.carriers.length;
}

/** Whether a request ended on a timer: the lookup's budget, not a failure on the way. */
function timedOut(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1, current = current.cause) {
    if (current.name === 'TimeoutError') return true;
  }
  return false;
}

/** The lookup left Ordertracker reading: it has its answer `waitMs` from now. */
function stillReading(waitMs: number, cause?: unknown): IndeterminateError {
  return new IndeterminateError(SOURCE, 'Ordertracker is still reading the carriers for the number',
    { reason: STILL_READING, retryAfterMs: Math.max(0, Math.ceil(waitMs)), ...(cause === undefined ? {} : { cause }) });
}

/** The wording and place of a scan, as its feed writes them; empty wording when the feed lost it. */
function readLines(lines: string[], feed: OrdertrackerFeed): Scan {
  if (feed.lines === 'wording') return { wording: lines[0] ?? '', location: '' };
  if (feed.lines === 'trailing_place') {
    const line = lines[0] ?? '';
    for (const pattern of [TRAILING_CAPITALS, TRAILING_WORD]) {
      const match = pattern.exec(line);
      if (!match || !countryCode(match[3])) continue;
      const [, wording, town, country, detail] = match;
      return { wording: detail ? `${wording} — ${detail}` : wording!, location: place(`${town}, ${country}`) };
    }
    const country = TRAILING_COUNTRY.exec(line);
    return country && countryCode(country[2]) ? { wording: country[1]!, location: country[2]! } : { wording: line, location: '' };
  }
  const placeOf = (line: string) => {
    if (feed.lines === 'bracketed_place') {
      const match = BRACKETED.exec(line);
      return match ? place(match[1] ?? match[2]) : null;
    }
    // Without the delivery office's postcode before the country ("10001,USA").
    return PLACE_LINES.some((pattern) => pattern.test(line)) ? place(line.replace(/^\d{3,6}(?:-\d{4})?,\s?/, '')) : null;
  };
  let scan: Scan = { wording: '', location: '' };
  for (const line of lines) {
    const named = placeOf(line);
    if (named !== null) scan = { ...scan, location: scan.location || named };
    else if (!scan.wording) scan = { ...scan, wording: line };
  }
  return scan;
}

interface Copy { feed: OrdertrackerFeed; rank: number; wall: string; wording: string; location: string }

const minuteOf = (wall: string) => Date.parse(`${wall.slice(0, 16)}Z`) / 60_000;

/**
 * Whether two feeds' copies under one scan number are one scan: the same minute on one clock,
 * or a whole number of quarter hours apart, within a day's offsets, from a UTC copy.
 */
function oneScan(a: Copy, b: Copy): boolean {
  const gap = Math.abs(minuteOf(a.wall) - minuteOf(b.wall));
  return a.feed !== b.feed && (a.feed.clock === b.feed.clock ? gap === 0 : gap <= 15 * 60 && gap % 15 === 0);
}

const readable = (wording: string) => classifyEvent(wording).stage_source !== 'none';

/**
 * Reads Ordertracker's reply for a number of `carrier`, keeping the scans of the carrier's
 * feeds (feeds.ts): Ordertracker merges what several feeds relay, at clocks that differ from
 * one feed to another. It numbers each scan in its time's milliseconds and gives every feed's
 * copy of a scan the same number, so a carrier's copies are read as one scan: on the clock of
 * its first listed feed, with the first wording the shared rules read and the first place. A
 * scan whose copies kept only a place helps date its neighbours and is then left out. Wall
 * clocks are dated as of `readAt`.
 */
export function parseOrdertrackerResponse(payload: unknown, carrier: string, readAt = Date.now()): CarrierResult {
  const feeds = ordertrackerFeeds(carrier);
  if (!feeds) throw new IndeterminateError(SOURCE, 'Ordertracker is not asked about this carrier', { reason: 'unsupported_scope' });
  if (!isRecord(payload) || !isRecord(payload.status) || !Array.isArray(payload.events) || !Array.isArray(payload.carriers)
    || payload.events.length > MAX_EVENTS) throw new SchemaError(SOURCE, 'Unreadable tracking reply');
  if (noInformation(payload)) throw new NoHistoryError(SOURCE, 'Ordertracker has no history for the number');
  const scans: Copy[][] = [];
  const numbered = new Map<string, Copy[][]>();
  for (const raw of payload.events) {
    if (!isRecord(raw)) throw new SchemaError(SOURCE, 'Unreadable tracking event');
    const rank = isRecord(raw.carrier) ? feeds.findIndex((feed) => feed.name === (raw.carrier as Record<string, unknown>).name) : -1;
    if (rank < 0) continue;
    const time = typeof raw.time === 'string' ? TIME.exec(raw.time) : null;
    if (!time || !Array.isArray(raw.lines)) throw new SchemaError(SOURCE, 'Undated tracking event');
    const feed = feeds[rank]!;
    const lines = raw.lines.map((line) => text(isRecord(line) ? line.original : null)).filter(Boolean);
    const copy: Copy = { feed, rank, wall: time[1]!, ...readLines(lines, feed) };
    const groups = numbered.get(time[2]!) ?? [];
    const group = groups.find((other) => other.every((each) => oneScan(each, copy)));
    if (group) group.push(copy);
    else {
      groups.push([copy]);
      scans.push(groups.at(-1)!);
      numbered.set(time[2]!, groups);
    }
  }
  if (!scans.length) throw new NoHistoryError(SOURCE, `Ordertracker relays no scan of ${carrier}'s feeds`, { reason: 'unattributed_history' });
  const read = scans.map((group) => {
    const copies = [...group].sort((a, b) => a.rank - b.rank);
    const worded = copies.filter((copy) => copy.wording);
    const { feed, wall } = copies[0]!;
    // A scan dated by its day alone comes at midnight. On La Poste's or Canada Post's instants,
    // midnight UTC is a time of day where the scan was.
    const day = wall.endsWith('T00:00:00') && (feed.clock === 'local' || feed.daysAtMidnight) ? wall.slice(0, 10) : null;
    const location = copies.find((copy) => copy.location)?.location ?? '';
    // A scan with a place, on a feed that writes those east of Greenwich on their wall clock, is dated by its place first.
    const east = feed.clock === 'utc' && !!feed.wallClockEast && !day && !!location;
    return { wall, day, utc: feed.clock === 'utc' && !day && !east, east,
      wording: (worded.find((copy) => readable(copy.wording)) ?? worded[0])?.wording ?? '', location };
  });
  // Their stages tell the places which scans the parcel was at, and so whose clock a neighbour borrows.
  const clocks: CarrierEvent[] = read.map((scan) => {
    const stage = scan.wording ? eventStage(scan.wording) : undefined;
    return { ...(scan.utc ? { time: `${scan.wall}Z` } : { local_time: scan.day ?? scan.wall }),
      description: scan.wording, ...(stage ? { stage } : {}), ...(scan.location ? { location: scan.location } : {}) };
  });
  const date = (events: CarrierEvent[]) => events.some((clock) => clock.local_time) ? dateLocalClocks(carrier, { events }, readAt).events ?? events : events;
  const placed = date(clocks);
  // Such a scan's country says on which side of Greenwich it was; its town, when the places know it, gives its zone.
  const countries = read.some((scan) => scan.east)
    ? date(clocks.map((clock, index) => {
      const country = read[index]!.east ? COUNTRY_TAIL.exec(read[index]!.location)?.[1] : undefined;
      return country ? { ...clock, location: country } : clock;
    }))
    : placed;
  // One that is not east of Greenwich, or whose country has no known zone, was written at its instant.
  const utc = read.map((scan, index) => scan.utc || (scan.east && !EAST_OF_GREENWICH.test(String(countries[index]!.time ?? ''))));
  const dated = placed.map((clock, index) => {
    if (!read[index]!.east) return clock;
    if (utc[index]) return { ...clocks[index]!, time: `${read[index]!.wall}Z` };
    return clock.time_zone_basis === 'place' ? clock : countries[index]!;
  });
  // A history whose newest scan lost its wording cannot say where the parcel is, and an older scan must not stand in for it.
  const clockOf = (index: number) => Date.parse(dated[index]!.time ?? `${dated[index]!.local_time}Z`) || 0;
  const newest = (worded: boolean) => Math.max(0, ...read.map((scan, index) => !!scan.wording === worded ? clockOf(index) : 0));
  if (newest(false) > newest(true)) throw new NoHistoryError(SOURCE, 'Ordertracker lost the wording of the newest scan', { reason: 'incomplete_history' });
  const events: CarrierEvent[] = [];
  for (const [index, scan] of read.entries()) {
    const clock = dated[index]!;
    const parsed = !scan.wording ? null : typeof clock.time === 'string' ? event(clock.time, scan.wording)
      : localEvent(scan.day ? `${scan.day}T00:00:00` : scan.wall, scan.wording);
    if (!parsed) continue;
    const zone = utc[index] ? {} : Object.fromEntries((['time', 'local_time', 'time_zone', 'time_zone_basis'] as const)
      .filter((field) => clock[field] !== undefined).map((field) => [field, clock[field]]));
    events.push({ ...parsed, ...zone, ...(scan.location ? { location: scan.location } : {}) });
  }
  return { ...result(events, SOURCE), tracking_source: 'structured-web-response' };
}

export const adapter: AdapterFactory = (environment) => {
  // When the read behind a request of this adapter that got no reply ends at the latest, by number.
  const reading = new Map<string, number>();
  return {
    id: SOURCE,
    steps: ['direct'],
    async track(input, context) {
      const number = numberOf(input.number);
      const carrier = input.carrier;
      if (!carrier || !ordertrackerFeeds(carrier)) {
        throw new IndeterminateError(SOURCE, 'Ordertracker answers only for a named carrier whose feed was checked', { reason: 'unsupported_scope' });
      }
      return runSteps({ carrier: SOURCE, budgetMs: context?.budgetMs ?? ORDERTRACKER_BUDGET_MS, signal: context?.signal,
        recorder: environment.recorder }, [{
        id: 'direct',
        run: async ({ remainingMs, signal }) => {
          const deadline = performance.now() + remainingMs;
          const url = `${ORDERTRACKER_API}?${new URLSearchParams({ trackingNumber: number, lang: 'en' })}`;
          for (;;) {
            for (const [asked, until] of reading) if (until <= performance.now()) reading.delete(asked);
            // An earlier request may have started the read this one finds under way.
            const pending = reading.has(number);
            let requests = 0;
            const fetcher: typeof fetch = (...request) => {
              requests += 1;
              if (!reading.has(number)) reading.set(number, performance.now() + ORDERTRACKER_READ_MS);
              return (environment.fetcher ?? fetch)(...request);
            };
            const left = () => (reading.get(number) ?? 0) - performance.now();
            let payload: unknown;
            try {
              const { bytes } = await fetchBounded(url, {
                signal,
                // The app's HTTP client.
                headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'okhttp/4.9.2', 'X-Mobile-Secret': MOBILE_SECRET },
              }, { provider: SOURCE, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: 2_000_000, fetcher,
                retryTransient: true, deadline });
              payload = parseJsonBytes(bytes, SOURCE);
            } catch (error) {
              // The lookup's budget ended before the read did: Ordertracker reads on, and the next ask finds its answer.
              if (timedOut(error) && !context?.signal?.aborted && left() > 0) throw stillReading(left(), error);
              throw error;
            }
            // "No information" is Ordertracker's answer only to the request that started the read, or once the read is over.
            if (!noInformation(payload) || !(pending || requests > 1) || left() <= 0) {
              reading.delete(number);
              return { ...parseOrdertrackerResponse(payload, carrier), tracking_url: pageOf(number) };
            }
            // Wait for the read's end when the budget covers it and the ask after it.
            const wait = Math.ceil(left()) + 25;
            if (performance.now() + wait + COLLECT_MS > deadline) throw stillReading(left());
            if (!await paused(wait, signal)) signal.throwIfAborted();
          }
        },
      }]);
    },
  };
};
