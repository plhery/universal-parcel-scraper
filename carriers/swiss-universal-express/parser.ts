import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { statusMap, sueStage } from './status.js';

export const PROVIDER = 'swiss-universal-express';
// A page is about six kilobytes.
export const SUE_MAX_BYTES = 256 * 1024;
/** The clock the year of a row is judged on: SUE's home, beside every country it serves. */
export const SUE_ZONE = 'Europe/Zurich';

// SUE, thirteen digits and two letters, as the one public number is: SUE…FR.
const NUMBER = /^SUE\d{13}[A-Z]{2}$/;
// Cloudflare's checks, which could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;
// The English page's title over a lookup: "Tracking information for <b>SUE…</b>".
const RESULT = /<div class="sue-result-title"[^>]*>\s*Tracking information for\s*<b>([^<]{0,64})<\/b>\s*<\/div>/;
const ERROR = /<div class="sue-error">([\s\S]*?)<\/div>/;
const NOT_FOUND = /^The number you entered is incorrect\b/i;
// "<span>03-28 at 10:39</span> - Your package is in our hands": the newest clock and the parcel's status.
const SUMMARY = /<div class="sue-result-sumup-title">\s*<span>([^<]*)<\/span>\s*-([^<]*)<\/div>/;
const STEP = /<div class="sue-result-step\b([^"]*)">\s*<div class="sue-result-step-label">([^<]*)<\/div>/g;
const TABLE = /<div class="sue-tracking-steps">\s*<table>([\s\S]*?)<\/table>/;
const ROW = /<tr>([\s\S]*?)<\/tr>/g;
const CELL = /<td>([\s\S]*?)<\/td>/g;
// "03-28 at 10:39": month, day and the facility's wall clock, without a year or a zone.
const CLOCK = /^(\d{2})-(\d{2}) at ([01]\d|2[0-3]):([0-5]\d)$/;
// A leap day can be four years back.
const YEARS_BACK = 4;
const MAX_ROWS = 200;

/** The progress bar's five steps, by their English labels, and the stage each one says the parcel has reached. */
const STEPS: ReadonlyMap<string, Stage> = new Map([
  ['being prepared', 'registered'],
  ['transiting in the shipping country', 'in_transit'],
  ['arrived in the delivery country', 'in_transit'],
  ['on your delivery site', 'in_transit'],
  ['delivered', 'delivered'],
]);

/** A Swiss Universal Express number: SUE, thirteen digits and two letters. */
export function normalizeSueNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Swiss Universal Express numbers are SUE, thirteen digits and two letters');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * A row's wall clock. The page gives a month and a day without a year: the year
 * is the latest that puts the clock no later than a day after the lookup, a day
 * being room for the clocks of the countries SUE serves. No offset is assigned.
 */
export function sueWallClock(text: string, now: number): string {
  const match = CLOCK.exec(textFromHtml(text, 40));
  if (match) {
    const latest = DateTime.fromMillis(now, { zone: SUE_ZONE }).plus({ days: 1 });
    const bound = latest.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    for (let year = latest.year; year >= latest.year - YEARS_BACK; year -= 1) {
      const date = calendarDay(year, Number(match[1]), Number(match[2]));
      if (date && `${date}T${match[3]}:${match[4]}:00` <= bound) return `${date}T${match[3]}:${match[4]}:00`;
    }
  }
  return invalid('Swiss Universal Express returned an invalid scan time');
}

/** The rows of the history table, after its header, as their three cells; null without the table. */
function rowsOf(html: string): string[][] | null {
  const table = TABLE.exec(html)?.[1];
  if (table === undefined) return null;
  const rows = [...table.matchAll(ROW)].map((row) => [...row[1]!.matchAll(CELL)].map((cell) => textFromHtml(cell[1], 300)));
  const [header, ...scans] = rows;
  if (!header || header.join('|').toLowerCase() !== 'date|localisation|details') return invalid('Swiss Universal Express returned an unreadable history');
  if (scans.length > MAX_ROWS) return invalid('Swiss Universal Express returned too many history rows');
  if (scans.some((cells) => cells.length !== 3)) return invalid('Swiss Universal Express returned an unreadable history row');
  return scans;
}

/** The stage of the furthest step the progress bar marks as reached or current. */
function barStage(html: string): Stage | undefined {
  const steps = [...html.matchAll(STEP)].map((step) => ({ reached: /\bsue-step-(?:achieved|current)\b/.test(step[1]!), label: textFromHtml(step[2], 80).toLowerCase() }));
  const reached = steps.filter((step) => step.reached).at(-1);
  return reached ? STEPS.get(reached.label) : undefined;
}

/**
 * Reads Swiss Universal Express's English tracking page for one number: the
 * number it echoes, the summary's status, the progress bar and the history
 * table, newest first. Rows keep their facility's wall clock, which the page
 * gives without a year or zone. A number the tracker does not hold gets its
 * notice that the number is incorrect.
 */
export function parseSue(html: string, number: string, now = Date.now()): CarrierResult {
  if (CHALLENGE.test(html)) throw new ChallengeError(PROVIDER, 'Swiss Universal Express returned a verification page');
  const result = RESULT.exec(html);
  if (!result) return invalid('Swiss Universal Express returned a page without a lookup');
  if (normalizeTrackingNumber(textFromHtml(result[1], 64)) !== number) throw new IndeterminateError(PROVIDER, 'Swiss Universal Express answered for another number');
  const error = ERROR.exec(html);
  if (error) {
    // The tracker words any number it does not hold so, and its own errors otherwise.
    if (NOT_FOUND.test(textFromHtml(error[1], 300))) throw new NotFoundError(PROVIDER, 'Swiss Universal Express has no parcel under this number');
    return invalid('Swiss Universal Express returned an error page');
  }

  const rows = rowsOf(html);
  const summary = SUMMARY.exec(html);
  // Neither the notice, the summary nor the history: not a page the tracker gives for a lookup.
  if (!rows && !summary) return invalid('Swiss Universal Express returned a lookup without its result');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const [clock, location, description] of rows ?? []) {
    if (!description) return invalid('Swiss Universal Express returned a row without its wording');
    const local = sueWallClock(clock!, now);
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = sueStage(description);
    events.push({ local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }

  const status = summary ? textFromHtml(summary[2], 200) : '';
  if (events.length === 0 && !status) throw new NoHistoryError(PROVIDER, 'Swiss Universal Express lists the parcel without its history', { reason: 'listed' });
  // The rows decide, then the summary's status, then the progress bar.
  const lead = leadingScan(events, statusMap);
  const fromStatus = status ? sueStage(status) : null;
  const fromBar = barStage(html);
  const staged: ClassifiedWording | null = lead?.stage ? { stage: lead.stage as Stage, source: lead.stage_source ?? 'carrier_map' }
    : fromStatus ?? (fromBar ? { stage: fromBar, source: 'carrier_map' } : null);
  const newest = events[0]?.local_time ?? (summary ? sueWallClock(summary[1]!, now) : undefined);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: events[0]?.description ?? status,
    last_update: null,
    ...(newest ? { last_update_local: newest } : {}),
    expected_delivery: null,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
