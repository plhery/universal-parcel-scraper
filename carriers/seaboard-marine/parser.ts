import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { seaboardMove } from './status.js';

export const PROVIDER = 'Seaboard Marine';
/** The page the website's equipment search opens, which renders the container's last move. */
export const SEABOARD_TRACKER = 'https://www.seaboardmarine.com/tracking-results/';
/** The page is a whole WordPress page of about a megabyte, its answer near the end. */
export const SEABOARD_MAX_BYTES = 2_500_000;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// The card the page fills, label by label, with a dash for each field it has no value for.
const LABELS = ['Vehicle Equipment N°:', 'EquipmentCheck:', 'Equipment Size:', 'Equipment Type:', 'Equipment Class:', 'Last move:', 'Date:'];
const EMPTY = '-';
const NO_INFORMATION = 'No Equipment Information Is Available At This Time.';
const EQUIPMENT = /^([A-Z]{4}) (\d{6}) (\d)$/;
const MOVE_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):([0-5]\d) ([AP]M)$/;
// The search form's opening tag; the page holds nothing else of the tracker's before it.
const FORM = /<form\s[^>]*action=["']?https:\/\/www\.seaboardmarine\.com\/tracking-results\/["'\s>]/i;
// The form and the card fit well within this much of the page after the form opens.
const ANSWER_CHARS = 40_000;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_Incapsula_Resource|Sorry, you have been blocked/i;

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A container whose check digit matches, and how the search form takes it: owner code, a space and the serial. */
export interface SeaboardQuery {
  number: string;
  search: string;
}

export function seaboardQuery(raw: string): SeaboardQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!CONTAINER.test(number)) throw new InvalidInputError(PROVIDER, 'Seaboard Marine tracks a container by its ISO 6346 number');
  if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
  return { number, search: `${number.slice(0, 4)} ${number.slice(4, 10)}` };
}

/** The address the search form opens for a container, with the form's empty VIN field. */
export function seaboardSearchUrl(query: SeaboardQuery): string {
  return `${SEABOARD_TRACKER}?${new URLSearchParams([['eq_number', query.search], ['vin_number', '']])}`;
}

/** The container's last move as the page's card shows it. */
export interface SeaboardMove {
  local_time: string;
  description: string;
}

/** The card's date, `MM/DD/YYYY hh:mm AM`, as a wall clock. */
function wallClock(date: string): string {
  const parts = MOVE_DATE.exec(date);
  const [month, day, hour] = [Number(parts?.[1]), Number(parts?.[2]), Number(parts?.[4])];
  const pad = (value: number) => String(value).padStart(2, '0');
  const local = parts && month >= 1 && month <= 12 && hour >= 1 && hour <= 12
    ? `${parts[3]}-${pad(month)}-${pad(day)}T${pad(hour % 12 + (parts[6] === 'PM' ? 12 : 0))}:${parts[5]}:00` : '';
  if (!local || local < '2001' || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'Seaboard Marine returned an invalid move time');
  return local;
}

/**
 * The page's answer for the container: its last move, bound to the container asked. The card
 * names the container by its owner code, serial and check digit. A card of dashes, as the page
 * shows before any search, is no answer; the card's notice that it has no information for the
 * container is a container Seaboard Marine does not track.
 */
export function seaboardMoveOf(html: string, query: SeaboardQuery): SeaboardMove {
  const start = html.search(FORM);
  if (start < 0) {
    if (CHALLENGE.test(html.slice(0, 200_000))) throw new ChallengeError(PROVIDER, 'Seaboard Marine\'s website refused the tracking request');
    throw new SchemaError(PROVIDER, 'Seaboard Marine returned a page without its tracker');
  }
  const $ = load(html.slice(start, start + ANSWER_CHARS));
  const asked = $('input[name="eq_number"]');
  if (asked.length !== 1 || clean(asked.attr('value'), 40) !== query.search) throw new SchemaError(PROVIDER, 'Seaboard Marine answered another search');
  const card = $('.printable-results');
  const rows = card.children('.sml-row').toArray().map((row) => $(row).children().toArray().map((cell) => clean($(cell).text(), 300)));
  if (card.length !== 1 || rows.length !== LABELS.length || rows.some((cells, index) => cells.length !== 2 || cells[0] !== LABELS[index])) {
    throw new SchemaError(PROVIDER, 'Seaboard Marine returned a card of another layout');
  }
  const [equipment, check, , , , wording, date] = rows.map((cells) => cells[1]!) as [string, string, string, string, string, string, string];
  if (rows.every((cells) => cells[1] === EMPTY)) {
    throw new IndeterminateError(PROVIDER, 'Seaboard Marine\'s tracker shows nothing for the container', { reason: 'portal_not_found' });
  }
  const named = EQUIPMENT.exec(equipment);
  if (!named || `${named[1]} ${named[2]}` !== query.search || check !== named[3]) throw new SchemaError(PROVIDER, 'Seaboard Marine returned another container');
  if (wording === NO_INFORMATION) throw new NotFoundError(PROVIDER, 'Seaboard Marine has no information for the container');
  // The search takes no check digit: a container whose own differs is another one.
  if (`${named[1]}${named[2]}${named[3]}` !== query.number) throw new SchemaError(PROVIDER, 'Seaboard Marine returned another container');
  if (!wording || wording === EMPTY) throw new SchemaError(PROVIDER, 'Seaboard Marine returned a move without its wording');
  return { local_time: wallClock(date), description: wording };
}

/**
 * The container's last move, the only one the page shows: a wall clock, the place it names, and
 * its stage by its wording. The history is always truncated.
 */
export function seaboardResult(move: SeaboardMove): CarrierResult {
  const reading = seaboardMove(move.description);
  const stage = reading?.stage;
  const event: CarrierEvent = {
    local_time: move.local_time, ...(reading?.place ? { location: reading.place } : {}), description: move.description,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}),
  };
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: move.description, last_update: null, last_update_local: move.local_time,
    expected_delivery: null, history_truncated: true, events: [event],
  };
}
