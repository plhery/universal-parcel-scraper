import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { marfretMove, type MarfretMove } from './status.js';

export const PROVIDER = 'Marfret';
export const MARFRET_ORIGIN = 'https://marfret-api.locussoftware.com';
/** Marfret's container tracker, a page of Locus Software's Odyssey that marfret.com frames. */
export const MARFRET_TRACKER = `${MARFRET_ORIGIN}/Odyssey/public/marfret/ContainerTrackSearch.seam`;
export const MARFRET_MAX_BYTES = 1_000_000;
/** The pages of moves read for one container, far more than one cycle fills. */
export const MAX_PAGES = 5;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
const COLUMNS = ['Container Number', 'Date', 'Event Type', 'Location', 'Voyage'];
const NO_RECORDS = 'No records found.';
// The view of a JSF page: two numbers for a view the server holds, or the encoded view itself.
const VIEW_STATE = /^[A-Za-z0-9+/=:._-]{1,8192}$/;
const MAX_PAGE_ROWS = 100;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required! \| Cloudflare)|Sorry, you have been blocked/i;

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number whose check digit matches. */
export function marfretQuery(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!CONTAINER.test(number)) throw new InvalidInputError(PROVIDER, 'Marfret tracks a container by its ISO 6346 number');
  if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
  return number;
}

/** The tracker's search for a container, as its search button posts it. */
export function marfretSearchForm(number: string, viewState: string): URLSearchParams {
  return new URLSearchParams([
    ['javax.faces.partial.ajax', 'true'],
    ['javax.faces.source', 'cTFormView:ctSearchButton'],
    ['javax.faces.partial.execute', 'cTFormView'],
    ['javax.faces.partial.render', 'contTableForm provTableForm'],
    ['cTFormView:ctSearchButton', 'cTFormView:ctSearchButton'],
    ['cTFormView', 'cTFormView'],
    ['cTFormView:ctSelect', 'CONTNUM'],
    ['cTFormView:searchText', number],
    ['javax.faces.ViewState', viewState],
  ]);
}

/**
 * A page of the table's moves. The table's own paginator answers with an empty table unless the
 * search runs again, so the page's request carries the search form and its button.
 */
export function marfretPageForm(number: string, viewState: string, first: number, rows: number): URLSearchParams {
  return new URLSearchParams([
    ['javax.faces.partial.ajax', 'true'],
    ['javax.faces.source', 'contTableForm:TBtrackView'],
    ['javax.faces.partial.execute', 'cTFormView contTableForm:TBtrackView'],
    ['javax.faces.partial.render', 'contTableForm:TBtrackView'],
    ['contTableForm:TBtrackView', 'contTableForm:TBtrackView'],
    ['contTableForm:TBtrackView_pagination', 'true'],
    ['contTableForm:TBtrackView_first', String(first)],
    ['contTableForm:TBtrackView_rows', String(rows)],
    ['contTableForm:TBtrackView_skipChildren', 'true'],
    ['contTableForm:TBtrackView_encodeFeature', 'true'],
    ['contTableForm', 'contTableForm'],
    ['cTFormView:ctSearchButton', 'cTFormView:ctSearchButton'],
    ['cTFormView', 'cTFormView'],
    ['cTFormView:ctSelect', 'CONTNUM'],
    ['cTFormView:searchText', number],
    ['javax.faces.ViewState', viewState],
  ]);
}

/** Cloudflare's check or block page in place of the tracker's. */
function refusal(body: string): void {
  if (CHALLENGE.test(body.slice(0, 100_000))) throw new ChallengeError(PROVIDER, 'Cloudflare refused Marfret\'s tracking request');
}

/** The view the tracker's page opens, which its search posts back. */
export function marfretViewState(html: string): string {
  refusal(html);
  const $ = load(html);
  const form = $('form[id="cTFormView"]');
  const viewState = form.find('input[name="javax.faces.ViewState"]').first().attr('value') ?? '';
  if (!form.find('select[name="cTFormView:ctSelect"] option[value="CONTNUM"]').length || !form.find('input[name="cTFormView:searchText"]').length
    || !form.find('button[name="cTFormView:ctSearchButton"]').length || !VIEW_STATE.test(viewState)) {
    throw new SchemaError(PROVIDER, 'Marfret\'s tracker page changed');
  }
  return viewState;
}

/** A partial response's updates by id, or null when the tracker no longer holds the view the request posted. */
function partialUpdates(body: string): ReadonlyMap<string, string> | null {
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<partial-response[\s>]/.test(body.slice(0, 500))) {
    refusal(body);
    throw new SchemaError(PROVIDER, 'Marfret returned a page in place of its tracker\'s reply');
  }
  const $ = load(body, { xml: true });
  const root = $.root().children('partial-response');
  if (root.length !== 1) throw new SchemaError(PROVIDER, 'Marfret returned an invalid reply');
  if (root.children('redirect').length) return null;
  const error = root.find('error');
  if (error.length) {
    if (/ViewExpired/i.test(error.find('error-name').text())) return null;
    throw new TransportError(PROVIDER, 'Marfret\'s tracker failed on the search');
  }
  const updates = new Map<string, string>();
  root.children('changes').children('update').each((_, element) => {
    const id = $(element).attr('id');
    if (id) updates.set(id, $(element).text());
  });
  return updates;
}

/** The view a reply gives the next request, when it gives one. */
function viewStateOf(updates: ReadonlyMap<string, string>): string | null {
  const value = [...updates].find(([id]) => /(?:^|:)javax\.faces\.ViewState(?::\d+)?$/.test(id))?.[1].trim();
  if (value === undefined) return null;
  if (!VIEW_STATE.test(value)) throw new SchemaError(PROVIDER, 'Marfret returned an invalid view');
  return value;
}

// The tracker names each place with its UN/LOCODE, as "[AU MEL]". These ports' countries keep
// several zones, or one core reads by the country's name only. Spain's and Portugal's islands
// keep clocks of their own, so only the mainland ports listed here have one.
const PORT_ZONES: Readonly<Record<string, string>> = {
  AUBNE: 'Australia/Brisbane', AUMEL: 'Australia/Melbourne', AUSYD: 'Australia/Sydney', BRFOR: 'America/Fortaleza',
  ECGYE: 'America/Guayaquil', ESALG: 'Europe/Madrid', ESBCN: 'Europe/Madrid', ESVGO: 'Europe/Madrid', ESVLC: 'Europe/Madrid',
  NCNOU: 'Pacific/Noumea', PFPPT: 'Pacific/Tahiti',
};
const LOCODE = /\[([A-Z]{2}) ([A-Z2-9]{3})\]$/;
const MOVE_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}) (\d{1,2}):([0-5]\d) ([AP]M)$/;
const pad = (value: number) => String(value).padStart(2, '0');

/** A move's wall clock, and the instant it gives when its place's country or port keeps one zone. */
function stamp(date: string, location: string) {
  const parts = MOVE_DATE.exec(date);
  const [month, day, hour] = [Number(parts?.[1]), Number(parts?.[2]), Number(parts?.[4])];
  const local = parts && month >= 1 && month <= 12 && hour >= 1 && hour <= 12
    ? `20${parts[3]}-${pad(month)}-${pad(day)}T${pad(hour % 12 + (parts[6] === 'PM' ? 12 : 0))}:${parts[5]}:00` : '';
  if (!local || local < '2001' || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'Marfret returned an invalid move time');
  const code = LOCODE.exec(location);
  const zone = code ? PORT_ZONES[`${code[1]}${code[2]}`] ?? (code[1] === 'ES' || code[1] === 'PT' ? null : countryTimeZone(code[1]!)) : null;
  const instant = zone ? isoTime(local, zone) : null;
  return instant ? { local_time: local, time: instant.iso, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

/** A move as the table lists it, before the cycle stages it. */
export type MarfretRow = CarrierEvent & { local_time: string; description: string };

/**
 * A table's rows from its index `first`, each naming the container asked, or null for the
 * table's message that it holds none.
 */
function tableRows($: CheerioAPI, body: Cheerio<Element>, number: string, first: number): MarfretRow[] | null {
  const rows = body.children().toArray();
  if (rows.length === 1 && $(rows[0]).is('tr.ui-datatable-empty-message')) {
    if (clean($(rows[0]).text()) !== NO_RECORDS) throw new SchemaError(PROVIDER, 'Marfret returned an unexpected message in its table');
    return null;
  }
  if (rows.length > MAX_PAGE_ROWS) throw new SchemaError(PROVIDER, 'Marfret returned too many rows');
  return rows.map((row, index) => {
    if (!$(row).is('tr') || $(row).attr('data-ri') !== String(first + index)) throw new SchemaError(PROVIDER, 'Marfret returned rows out of order');
    const cells = $(row).children('td').toArray().map(cell => clean($(cell).text(), 400));
    if (cells.length !== COLUMNS.length) throw new SchemaError(PROVIDER, 'Marfret returned a row of another layout');
    const [container, date, wording, location] = cells as [string, string, string, string];
    if (container !== number) throw new SchemaError(PROVIDER, 'Marfret returned another container');
    if (!wording) throw new SchemaError(PROVIDER, 'Marfret returned a move without its wording');
    return { ...stamp(date, location), ...(location ? { location } : {}), description: wording };
  });
}

/** The table's page size and how many moves it holds, from its paginator. */
function paginator(script: string): { rows: number; rowCount: number } {
  const rows = Number(/\brows:(\d{1,4})\b/.exec(script)?.[1]);
  const rowCount = Number(/\browCount:(\d{1,6})\b/.exec(script)?.[1]);
  if (!(rows > 0) || !(rowCount >= 0)) throw new SchemaError(PROVIDER, 'Marfret returned a table without its paginator');
  return { rows, rowCount };
}

/** The provisional moves, which the tracker lists apart: how many name the container. */
function provisionalRows(form: string, number: string): number {
  const $ = load(form);
  const rows = $('tbody[id="provTableForm:TBtrackView_data"] > tr[data-ri]').toArray();
  for (const row of rows) {
    if (clean($(row).children('td').first().text(), 40) !== number) throw new SchemaError(PROVIDER, 'Marfret returned another container');
  }
  return rows.length;
}

/** A search's first page of moves, the table's size, and whether the tracker names the container. */
export interface MarfretSearch {
  viewState: string | null;
  rows: MarfretRow[];
  rowCount: number;
  pageRows: number;
  listed: boolean;
}

/**
 * The search's reply: the table of moves, newest first, under a header naming the container, and
 * the planned moves apart. Null when the tracker no longer holds the view the search posted.
 */
export function marfretSearch(body: string, number: string): MarfretSearch | null {
  const updates = partialUpdates(body);
  if (!updates) return null;
  const form = updates.get('contTableForm');
  const planned = updates.get('provTableForm');
  if (form === undefined || planned === undefined) throw new SchemaError(PROVIDER, 'Marfret returned a reply without its tables');
  const $ = load(form);
  const heads = $('thead[id="contTableForm:TBtrackView_head"] th').toArray().map(cell => clean($(cell).text(), 100));
  const table = $('tbody[id="contTableForm:TBtrackView_data"]');
  if (heads.join('|') !== COLUMNS.join('|') || table.length !== 1) throw new SchemaError(PROVIDER, 'Marfret returned a table of another layout');
  const { rows: pageRows, rowCount } = paginator($('script[id="contTableForm:TBtrackView_s"]').text());
  const header = $('ul.seContainer li.seItem').first();
  const named = header.length ? clean(header.text(), 40) : '';
  if (named && named !== number) throw new SchemaError(PROVIDER, 'Marfret returned another container');
  const rows = tableRows($, table, number, 0);
  const provisional = provisionalRows(planned, number);
  // Only the table's message says it holds no move: a table left empty without it has changed.
  if (rows ? !rows.length || rows.length > pageRows || rows.length > rowCount || (rows.length < pageRows && rows.length !== rowCount) : rowCount !== 0) {
    throw new SchemaError(PROVIDER, 'Marfret returned a table whose rows do not match its paginator');
  }
  return { viewState: viewStateOf(updates), rows: rows ?? [], rowCount, pageRows, listed: Boolean(named) || provisional > 0 };
}

/** A later page's moves from index `first`, or null when the tracker no longer holds the view. */
export function marfretPage(body: string, number: string, first: number): { viewState: string | null; rows: MarfretRow[] } | null {
  const updates = partialUpdates(body);
  if (!updates) return null;
  const fragment = updates.get('contTableForm:TBtrackView');
  if (fragment === undefined) throw new SchemaError(PROVIDER, 'Marfret returned a page without its rows');
  const $ = load(`<table><tbody>${fragment}</tbody></table>`);
  return { viewState: viewStateOf(updates), rows: tableRows($, $('tbody').first(), number, first) ?? [] };
}

const VOYAGE: ReadonlySet<MarfretMove | undefined> = new Set<MarfretMove>(['loaded onboard', 'discharged']);

/**
 * The stage of each move, oldest first, by where it falls in the container's cycle. Before the
 * first load or discharge the container is booked and reaches the terminal; an empty one gated
 * into a depot then was not used. Until the last load or discharge it is in transit, and so it
 * stays after a last load. After the last discharge it leaves with the consignee, and a gate in
 * once it left is the empty return.
 */
function cycleStages(moves: readonly (MarfretMove | undefined)[]): (Stage | undefined)[] {
  const firstVoyage = moves.findIndex(move => VOYAGE.has(move));
  let lastVoyage = -1;
  moves.forEach((move, index) => { if (VOYAGE.has(move)) lastVoyage = index; });
  const arrived = lastVoyage >= 0 && moves[lastVoyage] === 'discharged';
  let left = false;
  return moves.map((move, index): Stage | undefined => {
    if (!move) return undefined;
    if (firstVoyage < 0 || index < firstVoyage) return move === 'depot gate in' ? undefined : move === 'terminal gate in' ? 'accepted' : 'registered';
    if (index <= lastVoyage || !arrived) return 'in_transit';
    if (move.endsWith('gate out')) {
      left = true;
      return 'out_for_delivery';
    }
    return move.endsWith('gate in') && left ? 'delivered' : 'in_transit';
  });
}

/**
 * The container's moves, newest first as the tracker lists them, staged by their cycle. A table
 * without moves is a container Marfret does not hold, unless the tracker names it, in its header
 * or its provisional moves.
 */
export function marfretResult(rows: readonly MarfretRow[], { listed, truncated }: { listed: boolean; truncated: boolean }): CarrierResult {
  const seen = new Set<string>();
  const moves = rows.filter(row => {
    const key = JSON.stringify([row.local_time, row.description, row.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!moves.length) {
    if (listed) throw new NoHistoryError(PROVIDER, 'Marfret lists the container without moves', { reason: 'listed' });
    throw new NotFoundError(PROVIDER, 'Marfret does not hold this container');
  }
  const oldestFirst = [...moves].reverse();
  const stages = cycleStages(oldestFirst.map(row => marfretMove(row.description)));
  const events: CarrierEvent[] = oldestFirst.map((row, index) => {
    const stage = stages[index];
    return { ...row, ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
  }).reverse();
  const newest = events[0]!;
  const stage = events.find(event => event.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: newest.time ?? null, ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null, ...(truncated ? { history_truncated: true } : {}), events,
  };
}
