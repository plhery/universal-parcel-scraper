import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { polarExpressStage } from './status.js';

export const PROVIDER = 'polar-express';
// A page is about fifteen kilobytes; its long history is a few more.
export const POLAR_EXPRESS_MAX_BYTES = 512 * 1024;

// Polar Express numbers its parcels PE, nine digits and US or CA, and also ships under numbers a post issues in the
// same layout: the tracker answers those too.
const NUMBER = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const NOT_FOUND = /<h4>\s*Not Found\s*<\/h4>\s*There is no any tracking information by such tracking number/i;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied|DDoS-Guard)|ddos-guard|g-recaptcha|h-captcha|captcha/i;
const INFORMATION = /Parcel information:([\s\S]*?)Travel history:/;
// A label cell ending in a colon, then its value, which is no label: "Service:", "Weight (kg):", "EMS tracking number:".
const FIELD = /<td[^>]*>\s*([A-Za-z][A-Za-z ()]{0,40}):\s*<\/td>\s*<td[^>]*>(?!\s*[A-Za-z][A-Za-z ()]{0,40}:\s*<\/td>)([\s\S]*?)<\/td>/g;
const TIMELINE = 'var timeline_data=';
// "2023-01-08 17:30:05": a row's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
// "[BPOST] - Machelen", "[BOXBERRY] --- ", " --- ", "DUBAI SORTING CENTRE": the partner a row comes from, then its place.
const TITLE = /^(?:\[[A-Z][A-Z0-9 ]{0,20}\]\s*)?(.*)$/;
// Emirates Post's delivery names whoever took the parcel after it.
const RECEIVER = /\s*-\s*Received\s+by\s*:.*$/i;
const WEIGHT = /^(\d{1,4}(?:\.\d{1,3})?) kg\.?$/;
const MAX_TIMELINE_CHARS = 200_000;
const MAX_ROWS = 300;

/** A number Polar Express's tracker reads: two letters, nine digits and two letters. */
export function normalizePolarExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Polar Express tracking number: two letters, nine digits and two letters');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The fields of the page's "Parcel information" table, by their label without its colon. */
function fieldsOf(html: string): Map<string, string> {
  const table = INFORMATION.exec(html)?.[1];
  if (table === undefined) return invalid('the-tracking.com returned a page without its parcel information');
  return new Map([...table.matchAll(FIELD)].map((match) => [match[1]!.trim(), textFromHtml(match[2], 200)]));
}

type Row = Record<string, string>;

/**
 * The rows of `var timeline_data=[{type:'…',date:'…',title:'…',content:'…',},…];`, a script's
 * array of objects whose values are quoted strings, read without running it.
 */
export function timelineRows(html: string): Row[] {
  const start = html.indexOf(TIMELINE);
  if (start < 0) return invalid('the-tracking.com returned a page without its travel history');
  const source = html.slice(start + TIMELINE.length, start + TIMELINE.length + MAX_TIMELINE_CHARS);
  let index = 0;
  const space = () => { while (/\s/.test(source[index] ?? '')) index += 1; };
  const expect = (char: string) => {
    space();
    if (source[index] !== char) invalid('the-tracking.com returned an unreadable travel history');
    index += 1;
  };
  const optional = (char: string) => {
    space();
    if (source[index] !== char) return false;
    index += 1;
    return true;
  };
  const string = (): string => {
    space();
    const quote = source[index];
    if (quote !== "'" && quote !== '"') return invalid('the-tracking.com returned an unreadable travel history');
    let value = '';
    for (index += 1; index < source.length; index += 1) {
      const char = source[index]!;
      if (char === quote) {
        index += 1;
        return value;
      }
      if (char !== '\\') {
        value += char;
        continue;
      }
      const next = source[index + 1] ?? '';
      const hex = next === 'u' ? /^[0-9a-fA-F]{4}/.exec(source.slice(index + 2)) : next === 'x' ? /^[0-9a-fA-F]{2}/.exec(source.slice(index + 2)) : null;
      if (hex) {
        value += String.fromCharCode(parseInt(hex[0], 16));
        index += 1 + hex[0].length;
      } else {
        value += ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[next] ?? next;
        index += 1;
      }
    }
    return invalid('the-tracking.com returned an unreadable travel history');
  };
  const rows: Row[] = [];
  expect('[');
  while (!optional(']')) {
    if (rows.length >= MAX_ROWS) invalid('the-tracking.com returned too many history rows');
    expect('{');
    const row: Row = {};
    while (!optional('}')) {
      space();
      const key = /^[A-Za-z_]\w{0,30}/.exec(source.slice(index))?.[0] ?? invalid('the-tracking.com returned an unreadable travel history');
      index += key.length;
      expect(':');
      row[key] = string();
      optional(',');
    }
    rows.push(row);
    optional(',');
  }
  return rows;
}

function clockOf(value: string | undefined): string {
  const parts = CLOCK.exec(value ?? '');
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2001) return invalid('the-tracking.com returned a history row with an invalid time');
  return `${day}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

/** The place a row's title names, without the partner's tag, its dashes or a pickup point's address. */
function placeOf(title: string | undefined): string {
  const rest = TITLE.exec(textFromHtml(title ?? '', 200))![1]!.trim();
  return rest.replace(/^-+\s*/, '').replace(/\s*-{2,}\s*$/, '').replace(/\s*\(.*\)$/, '').trim();
}

// Russian names of countries, as the page names the destination: "Россия, Воронеж".
let russianNames: Map<string, string> | undefined;
function countryOf(name: string): string | null {
  if (!russianNames) {
    russianNames = new Map();
    const names = new Intl.DisplayNames(['ru'], { type: 'region' });
    for (const first of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const second of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const code = first + second;
        const label = names.of(code);
        if (label && label !== code && countryCode(code) === code) russianNames.set(label.toLocaleLowerCase('ru'), code);
      }
    }
  }
  return russianNames.get(name.toLocaleLowerCase('ru')) ?? countryCode(name);
}

/**
 * Reads the-tracking.com's page for one number: the parcel information table and the travel
 * history its script draws. Rows keep their wall clock, as the page gives no zone; the
 * receiver's name, the partners' numbers and the destination town stay behind.
 */
export function parsePolarExpress(html: string, number: string): CarrierResult {
  if (CHALLENGE.test(html)) throw new ChallengeError(PROVIDER, 'the-tracking.com returned a verification page');
  if (NOT_FOUND.test(html)) throw new NotFoundError(PROVIDER, 'the-tracking.com has no tracking information for this number');
  const fields = fieldsOf(html);
  const tracked = fields.get('Track number');
  if (tracked === undefined) return invalid('the-tracking.com returned parcel information without its number');
  // The tracker shows its notice on an unknown number's first look, and on every look after it the table with
  // each field blank and no history.
  if (!tracked) {
    if ([...fields.values()].every((value) => value === '' || value === '--') && timelineRows(html).length === 0) {
      throw new NotFoundError(PROVIDER, 'the-tracking.com has no tracking information for this number');
    }
    return invalid('the-tracking.com returned parcel information without its number');
  }
  if (normalizeTrackingNumber(tracked) !== number) throw new IndeterminateError(PROVIDER, 'the-tracking.com answered for another number');
  // The tracker also shows other carriers' numbers, under their name or none: only Polar Express's parcels are this carrier's.
  if (!/^Polar Express\b/i.test(fields.get('Service') ?? '')) throw new IndeterminateError(PROVIDER, 'the-tracking.com answered for another carrier');

  const seen = new Set<string>();
  const events = timelineRows(html).map((row, index) => {
    const description = textFromHtml(row.content, 300).replace(RECEIVER, '');
    if (!description) invalid('the-tracking.com returned a history row without its wording');
    const location = placeOf(row.title);
    const stage = polarExpressStage(description);
    const event: CarrierEvent & { local_time: string } = { local_time: clockOf(row.date), description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return { index, event };
  }).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  // The page lists its rows oldest first: the newest first, and of rows at one clock the later.
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index).map(({ event }) => event);

  const status = fields.get('Status') ?? '';
  const summary = status && status !== '--' ? status : '';
  if (events.length === 0 && !summary) throw new NoHistoryError(PROVIDER, 'Polar Express lists the parcel without its history', { reason: 'listed' });
  const stage = (events.find((event) => event.stage)?.stage as Stage | undefined) ?? (summary ? polarExpressStage(summary) : undefined);
  const country = (fields.get('Delivery location') ?? '').split(',')[0]!.trim();
  const destination = country && country !== '--' ? countryOf(country) : null;
  const weight = WEIGHT.exec(fields.get('Weight (kg)') ?? '');
  const service = fields.get('Service type') ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]?.description ?? summary,
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : country && country !== '--' ? { destination_country_name: country } : {}),
    ...(weight && Number(weight[1]) > 0 ? { weight_kg: Number(weight[1]) } : {}),
    ...(service && service !== '--' ? { service_name: service } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
