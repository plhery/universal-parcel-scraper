import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, isoTime, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { hmmStage } from './status.js';

export const PROVIDER = 'HMM';
/** The tracking page, whose search posts the numbers typed into it. */
export const HMM_PAGE = 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do';
/** The lookup that search posts to, answered with the results as HTML. */
export const HMM_LOOKUP = 'https://www.hmm21.com/e-service/general/trackNTrace/selectTrackNTrace.do';
export const HMM_MAX_BYTES = 2_000_000;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// HMM's bills are four letters, its office and mode, and eight characters; import records put
// HDMU, its carrier code, before them. A booking has its bill's number.
const BILL = /^(?:HDMU)?([A-Z]{4}(?=[A-Z]*\d)[A-Z0-9]{8})$/;
const MAX_MOVES = 500;
const MAX_CONTAINERS = 500;

/** What HMM's page tracks: a bill of lading, or a container by its ISO 6346 number. */
export type HmmQuery = { kind: 'bl' | 'cntr'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number with its check digit, or a bill of lading with or without `HDMU`. */
export function hmmQuery(raw: string): HmmQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'cntr', number };
  }
  const bill = BILL.exec(number)?.[1];
  if (bill) return { kind: 'bl', number: bill };
  throw new InvalidInputError(PROVIDER, 'HMM tracks a bill of lading of twelve characters or a container number');
}

/** The JSON the page's search posts for one number. */
export const hmmRequestBody = (query: HmmQuery) => JSON.stringify({ type: query.kind, listBl: query.kind === 'bl' ? [query.number] : [],
  listCntr: query.kind === 'cntr' ? [query.number] : [], listBkg: [], listPo: [] });

// HMM writes a place as its town and its country, or its US state's code. It calls South Korea Korea.
const COUNTRIES: Readonly<Record<string, string>> = { KOREA: 'KR' };

/**
 * The zone of a place's wall clock: a US state's by its code, a country's when the country keeps
 * one. A two-letter code that is no US state's, as a Canadian province's, gives none.
 */
export function placeZone(place: string): string | null {
  const last = place.split(',').at(-1)!.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(last)) return usStateTimeZone(last);
  return countryTimeZone(COUNTRIES[last] ?? last);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A move's wall clock, and the instant it gives in its place's zone. */
function stamp(day: string, clock: string, place: string): Pick<CarrierEvent, 'time' | 'time_zone' | 'time_zone_basis'> & { local_time: string } {
  const local = `${day}T${clock}:00`;
  const year = Number(day.slice(0, 4));
  if (!DAY.test(day) || !CLOCK.test(clock) || year < 2001 || year > 2100 || !isoTime(local, 'UTC')) {
    throw new SchemaError(PROVIDER, 'HMM returned an invalid move time');
  }
  const zone = placeZone(place);
  const time = zone ? isoTime(local, zone) : null;
  return time ? { local_time: local, time: time.iso, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

const cells = ($: CheerioAPI, row: Parameters<CheerioAPI>[0]) => $(row).children('td').toArray().map(cell => clean($(cell).text(), 200));
const hidden = ($: CheerioAPI, id: string) => clean($(`input#${id}[type=hidden]`).attr('value') ?? '', 40);

/**
 * The stage a bill is at by each container's latest move. Its containers move apart: one
 * returned empty does not make the others delivered, so a delivery decides only once every
 * container has one, and a container whose latest move has no stage leaves the stage open.
 */
function billStage(latest: readonly { stage: Stage | undefined; at: string }[]): Stage | undefined {
  const open = latest.filter(item => item.stage && item.stage !== 'delivered').sort((left, right) => right.at.localeCompare(left.at))[0];
  if (open) return open.stage;
  return latest.length && latest.every(item => item.stage === 'delivered') ? 'delivered' : undefined;
}

/**
 * HMM's results for one bill of lading or container: the moves of the container the page shows,
 * newest first on their places' clocks, and the stage of the bill by each container's latest move.
 * The results must be for the number asked; HMM's answer for one it does not hold names the kind.
 */
export function hmmResult(html: string, query: HmmQuery): CarrierResult {
  const $ = load(html);
  const results = $('#trackingInfomationDateResultTable');
  if (results.length !== 1) throw new SchemaError(PROVIDER, 'HMM returned a page that is not its tracking results');
  const title = clean(results.find('.tab-title').first().text(), 200);
  if (!$('#shipmentProgress').length) {
    if (/^(B\/L|Container) no\. is invalid\./i.test(title)) {
      const kind = title.startsWith('B/L') ? 'bl' : 'cntr';
      if (kind !== query.kind) throw new SchemaError(PROVIDER, 'HMM looked up another kind of number');
      throw new NotFoundError(PROVIDER, kind === 'bl' ? 'HMM does not hold this bill of lading' : 'HMM does not hold this container');
    }
    throw new SchemaError(PROVIDER, 'HMM returned tracking results without a shipment history');
  }
  const bill = hidden($, 'thisBl');
  const shown = hidden($, 'thisCntr');
  if (query.kind === 'bl' ? bill !== query.number : shown !== query.number) throw new SchemaError(PROVIDER, 'HMM returned another number');

  const rows = $('#containerStatus tbody tr').toArray();
  if (!rows.length || rows.length > MAX_CONTAINERS) throw new SchemaError(PROVIDER, 'HMM returned an invalid container list');
  const containers = rows.map(row => {
    const [, number = '', , , , , owner = '', , , , , movement = '', at = ''] = cells($, row);
    if (!CONTAINER.test(number) || owner !== bill || (at && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at))) {
      throw new SchemaError(PROVIDER, 'HMM returned an invalid container row');
    }
    return { number, stage: movement ? hmmStage(movement) : undefined, at };
  });
  if (!containers.some(container => container.number === shown)) throw new SchemaError(PROVIDER, 'HMM returned moves of a container the shipment does not list');

  const moves = $('#shipmentProgress tr.clsMoves').toArray();
  if (moves.length > MAX_MOVES) throw new SchemaError(PROVIDER, 'HMM returned too many moves');
  const events = moves.map(row => {
    const [day = '', clock = '', place = '', description = ''] = cells($, row);
    if (!description) throw new SchemaError(PROVIDER, 'HMM returned a move without a description');
    const stage = hmmStage(description);
    return { ...stamp(day, clock, place), ...(place ? { location: place } : {}), description,
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) } satisfies CarrierEvent;
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));
  if (!events.length) throw new NoHistoryError(PROVIDER, 'HMM lists the shipment without moves', { reason: 'listed' });

  const newest = events[0]!;
  const stage = billStage(containers.map(container => container.number === shown && !container.stage
    ? { stage: events.find(event => event.stage)?.stage, at: newest.local_time } : container));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: newest.time ?? null, last_update_local: newest.local_time,
    expected_delivery: null, events,
  };
}
