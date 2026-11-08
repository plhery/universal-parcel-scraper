/**
 * A step a carrier records again within minutes, read once.
 * Every adapter's and provider's result goes through it before it leaves the package.
 */
import type { Stage } from '../../generated/catalog.js';
import { isRecord } from '../types.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { clocks, reading } from './registration.js';

/** How long after a scan the same wording at the same place still repeats it. */
const REPEAT_MS = 10 * 60_000;

const text = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';

/** A place as two copies of one scan are compared: case, accents, spacing and punctuation aside. */
export const comparablePlace = (value: unknown): string =>
  text(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A scan with an earlier scan's wording, place and stage, at most ten minutes after it, is left
 * out: a gateway that records one departure several times, or a failed attempt written once by
 * each of a carrier's systems, is one step. A scan of another stage between them keeps the
 * repeat, as a second round after a failed attempt. Scans without a wording or a clock stay.
 */
export function withoutRepeatedScans(result: CarrierResult): CarrierResult {
  const events: unknown[] = Array.isArray(result.events) ? result.events : [];
  if (events.length < 2) return result;
  const at = clocks(events);
  const read = events.map(reading);
  // Scans dated alike in the carrier's order (`tie_order`), so the first record of a step is the one kept.
  const tie = (index: number): number => { const event = events[index]; return isRecord(event) && typeof event.tie_order === 'number' ? event.tie_order : 0; };
  const order = events.flatMap((_, index) => at[index] === null ? [] : [index]).sort((left, right) => at[left]! - at[right]! || tie(left) - tie(right));
  // The newest kept scan of each wording, place and stage, and the stages of the scans kept since.
  const kept = new Map<string, { at: number; since: (Stage | null)[] }>();
  const repeats = new Set<number>();
  for (const index of order) {
    const event = events[index];
    const wording = isRecord(event) ? text(event.description) : '';
    const key = isRecord(event) && wording ? `${wording}\n${text(event.location)}\n${text(event.stage)}` : '';
    const earlier = key ? kept.get(key) : undefined;
    if (earlier && at[index]! - earlier.at <= REPEAT_MS && earlier.since.every(stage => stage === null || stage === read[index])) {
      repeats.add(index);
      continue;
    }
    for (const scan of kept.values()) scan.since.push(read[index] ?? null);
    if (key) kept.set(key, { at: at[index]!, since: [] });
  }
  if (!repeats.size) return result;
  return { ...result, events: events.filter((_, index) => !repeats.has(index)) as CarrierEvent[] };
}

const MINUTE_MS = 60_000;

/** Two places that name one: the same, one left out, or one that goes on after the other ("Town, ST" and "Town, ST, Town ST 00000"). */
const samePlace = (left: string, right: string): boolean => !left || !right || left === right
  || (left.length < right.length ? right.startsWith(`${left},`) : left.startsWith(`${right},`));

/**
 * One scan a provider's answer lists twice in one minute, from two of the networks it reads:
 * once to the minute and once to the second (YFH's scan at :00 and Cainiao's copy of it at :54).
 * The copy to the minute is left out, and the copy to the second stays, with the other's place
 * where it gives none. Both need the same wording apart from case and spacing, the same stage,
 * places that agree or one left out, codes that agree where both carry one, and a match unique
 * both ways. Scans of other words, stage or place in that minute stay, as do scans dated by day.
 */
export function withoutMinuteCopies(result: CarrierResult): CarrierResult {
  const events: unknown[] = Array.isArray(result.events) ? result.events : [];
  if (events.length < 2) return result;
  const at = clocks(events);
  const scans = events.map((event, index) => {
    const record = isRecord(event) ? event : {};
    return { index, at: at[index], wording: text(record.description), place: text(record.location), stage: text(record.stage),
      code: typeof record.provider_code === 'string' ? record.provider_code : '' };
  }).filter((scan) => scan.at !== null && scan.wording);
  const copies = (minute: typeof scans[number], second: typeof scans[number]) => minute.at! % MINUTE_MS === 0
    && second.at! % MINUTE_MS !== 0 && second.at! - (second.at! % MINUTE_MS) === minute.at
    && minute.wording === second.wording && minute.stage === second.stage && samePlace(minute.place, second.place)
    && (!minute.code || !second.code || minute.code === second.code);
  const merged = new Map<number, number>();
  for (const minute of scans) {
    const seconds = scans.filter((second) => copies(minute, second));
    if (seconds.length === 1 && scans.filter((other) => copies(other, seconds[0]!)).length === 1) merged.set(minute.index, seconds[0]!.index);
  }
  if (!merged.size) return result;
  const listed = events as CarrierEvent[];
  const places = new Map([...merged].map(([minute, second]) => [second, listed[minute]!.location]));
  return { ...result, events: listed.flatMap((event, index) => {
    if (merged.has(index)) return [];
    const place = places.get(index);
    return [place && !event.location ? { ...event, location: place } : event];
  }) };
}

const clockKey = (event: CarrierEvent): string => {
  if (typeof event.time === 'string') {
    const at = Date.parse(event.time);
    return Number.isFinite(at) ? `@${at}` : '';
  }
  return typeof event.local_time === 'string' ? event.local_time : '';
};

/**
 * One scan an answer lists twice at the same clock and place: in its short wording and in a
 * longer one that goes on after `separator` ("Colis non livré" and "Colis non livré : client
 * absent"). The short line is left out and the longer, more specific one stays. Codes must agree
 * where both lines carry one, unless `anyCode` says the source codes each line by its own words.
 * Separate scans, worded otherwise, stay; so do scans without a clock or a wording.
 */
export function withoutShortenedScans<T extends CarrierEvent>(events: readonly T[], separator: string, options: { anyCode?: boolean } = {}): T[] {
  const joint = separator.replace(/\s+/g, ' ').toLowerCase();
  const keyed = events.map((event) => ({ event, clock: clockKey(event), wording: text(event.description), place: text(event.location) }));
  const shortened = keyed.filter((scan) => scan.clock && scan.wording && keyed.some((other) => other !== scan
    && other.clock === scan.clock && other.place === scan.place && other.wording.startsWith(`${scan.wording}${joint}`)
    && (options.anyCode || !scan.event.provider_code || !other.event.provider_code || scan.event.provider_code === other.event.provider_code)));
  if (!shortened.length) return [...events];
  const left = new Set(shortened.map(({ event }) => event));
  return events.filter((event) => !left.has(event));
}
