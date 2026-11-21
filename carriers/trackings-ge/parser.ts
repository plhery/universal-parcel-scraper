import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { cleanScalar, textFromHtml } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { statusMap, trackingsGeStage, trackingsGeWordingStage } from './status.js';

export const PROVIDER = 'Trackings.GE';
/** The English tracker; its form posts the number back to the same address. */
export const TRACK_URL = 'https://trackings.ge/en/track';

const CHALLENGE = /cf-chl|cf-turnstile|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const ROW = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
const BADGE = /<span\b[^>]*\bclass="[^"]*\bbadge\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
const MAX_ROWS = 200;

/** A record of the reply: its code and its wall clock. */
interface Entry { code: string; day?: string; clock?: string }
/** A row of the page the reply renders: its date and wording. */
interface Row { day?: string; date: string; wording: string }

export function trackingsGeNumber(raw: string): string {
  const number = raw.trim();
  if (!/^[A-Za-z0-9]{4,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter one Trackings.GE tracking code');
  return number;
}

/** The token the tracker's form sends with its lookup, from the page's `csrf-token` meta tag. */
export function readFormToken(html: string): string {
  const token = /<meta\s+name="csrf-token"\s+content="([A-Za-z0-9]{20,100})"/i.exec(html)?.[1];
  if (token) return token;
  if (CHALLENGE.test(html.slice(0, 20_000))) throw new ChallengeError(PROVIDER, 'Trackings.GE answered with a browser check');
  throw new SchemaError(PROVIDER, 'Trackings.GE served its tracker without the form token');
}

const identity = (value: unknown): string => cleanScalar(value, 80).toUpperCase().replace(/[\s-]/g, '');

/** One record of the reply, which has to name the number asked. */
function entry(record: unknown, number: string): Entry {
  if (!isRecord(record)) throw new SchemaError(PROVIDER, 'Trackings.GE returned an invalid record');
  const names = [record.gcb_track_num, record.cust_track_num_01, record.cust_track_num_02].map(identity);
  if (!names.includes(identity(number))) throw new IndeterminateError(PROVIDER, 'Trackings.GE answered for another number');
  const code = cleanScalar(record.status_code, 16);
  if (!/^\d+$/.test(code)) throw new SchemaError(PROVIDER, 'Trackings.GE returned a record without its status code');
  const clock = zonedTime(record.status_date, 'yyyy-MM-dd HH:mm:ss', 'UTC');
  return clock ? { code, day: clock.iso.slice(0, 10), clock: clock.iso.slice(0, 19) } : { code };
}

/** The rows of the page's history, in page order: a date badge, then the wording. */
function pageRows(tree: string): Row[] {
  const rows = [...tree.matchAll(ROW)].map(([, item]) => {
    const badge = BADGE.exec(item!);
    const wording = textFromHtml(badge ? item!.replace(badge[0], ' ') : '');
    if (!badge || !wording) throw new SchemaError(PROVIDER, 'Trackings.GE returned a history row without its date or wording');
    const date = textFromHtml(badge[1]);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? zonedTime(date, 'yyyy-MM-dd', 'UTC')?.iso.slice(0, 10) : undefined;
    return { date, wording, ...(day ? { day } : {}) };
  });
  if (rows.length === 0 && textFromHtml(tree)) throw new SchemaError(PROVIDER, 'Trackings.GE returned an unreadable history');
  return rows;
}

/** Whether the page lists its rows newest first, when their dates tell. */
function listsNewestFirst(rows: readonly Row[]): boolean | undefined {
  const days = rows.flatMap((row) => row.day ? [row.day] : []);
  const [first, last] = [days[0], days.at(-1)];
  return first === undefined || last === undefined || first === last ? undefined : first > last;
}

/**
 * The record each row renders. The page leaves out records whose code it has no wording for,
 * so a row takes the clock and code of the records of its day only when the day has as many
 * records as rows, and several rows of one day only when the page's order is known.
 */
function recordsOf(rows: readonly Row[], entries: readonly Entry[], newestFirst: boolean | undefined): Map<Row, Entry> {
  const paired = new Map<Row, Entry>();
  for (const day of new Set(rows.flatMap((row) => row.day ? [row.day] : []))) {
    const shown = rows.filter((row) => row.day === day);
    const kept = entries.filter((record) => record.day === day)
      .sort((left, right) => left.clock! < right.clock! ? -1 : left.clock! > right.clock! ? 1 : 0);
    if (kept.length !== shown.length || (shown.length > 1 && newestFirst === undefined)) continue;
    if (newestFirst) kept.reverse();
    shown.forEach((row, index) => paired.set(row, kept[index]!));
  }
  return paired;
}

export function parseTrackingsGe(body: string, number: string): CarrierResult {
  const text = body.trim();
  if (text.startsWith('<')) {
    if (CHALLENGE.test(text.slice(0, 20_000))) throw new ChallengeError(PROVIDER, 'Trackings.GE answered with a browser check');
    throw new SchemaError(PROVIDER, 'Trackings.GE answered its lookup with a page');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Trackings.GE returned a reply that is not JSON', { cause });
  }
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Trackings.GE returned an invalid reply');
  // The tracker's own "Sorry, your track … was not found" answer.
  if (payload.err_msg === 'no_such_track') throw new NotFoundError(PROVIDER);
  if (typeof payload.err_msg !== 'string') throw new SchemaError(PROVIDER, 'Trackings.GE returned a reply without its answer');
  if (payload.err_msg !== 'track_found') throw new IndeterminateError(PROVIDER, 'Trackings.GE did not complete the lookup');
  // The page renders orders booked on Trackings.GE itself from another layout, not seen yet.
  if (payload.source === 'trackings.ge') {
    throw new SchemaError(PROVIDER, 'Trackings.GE answered in the layout of its own orders, which the adapter does not read');
  }

  const records = payload.data;
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_ROWS || typeof payload.tracking_tree !== 'string') {
    throw new SchemaError(PROVIDER, 'Trackings.GE returned a reply without its records');
  }
  const entries = records.map((record) => entry(record, number));
  const rows = pageRows(payload.tracking_tree);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Trackings.GE returned an unexpectedly long history');
  if (rows.length === 0) throw new NoHistoryError(PROVIDER, 'Trackings.GE lists the parcel without a step it words', { reason: 'listed' });

  const newestFirst = listsNewestFirst(rows);
  const paired = recordsOf(rows, entries, newestFirst);
  const built = rows.map((row): CarrierEvent => {
    const record = paired.get(row);
    const staged = trackingsGeStage(row.wording);
    return {
      ...(record ? { local_time: record.clock!, provider_code: record.code } : row.day ? { local_time: row.day } : { provider_time_text: row.date }),
      description: row.wording,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  // Oldest first, as the reply's records run, unless the page's dates say otherwise.
  if (!newestFirst) built.reverse();
  const events = built.sort((left, right) => {
    const [later, earlier] = [String(right.local_time ?? ''), String(left.local_time ?? '')];
    return later > earlier ? 1 : later < earlier ? -1 : 0;
  });

  const summary = textFromHtml(payload.track_status_smg);
  const lead = leadingScan(events, statusMap);
  const summaryStage = summary ? trackingsGeWordingStage(summary) : undefined;
  const stage = (lead?.stage ?? summaryStage) as Stage | undefined;
  const source = lead ? String(lead.stage_source) : 'carrier_map';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: summary || events[0]!.description!,
    last_update: null,
    last_update_local: events.find((event) => event.local_time)?.local_time ?? null,
    expected_delivery: null,
    events,
  };
}
