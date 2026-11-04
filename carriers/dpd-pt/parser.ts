import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import {
  DPD_PT_COLLECTION, DPD_PT_DELIVERY, DPD_PT_FORECAST, DPD_PT_POINT_RECEIPT, DPD_PT_RETURN, DPD_PT_RETURNED, DPD_PT_WINDOW, dpdPtStage,
  isDpdPtNotice,
} from './status.js';

export const PROVIDER = 'DPD Portugal';
// The page is under 50 kB with a long history.
export const DPD_PT_MAX_BYTES = 1024 * 1024;

const LABEL = 'Nº de encomenda';
// The page words its notice in English or in Portuguese.
const NOT_FOUND = ['No results were found for', 'Não encontrámos resultados para'];
const HEADERS = ['Código', 'Data', 'Hora', 'Descrição', 'Comentário', 'Localização'];
const CODE = /^[A-Z0-9]{1,8}$/;
const DATE = /^(\d{2})-(\d{2})-(\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
// The delivery window a message to the recipient gives, as "10:45 - 11:45".
const WINDOW = /^((?:[01]\d|2[0-3]):[0-5]\d)\s*-\s*((?:[01]\d|2[0-3]):[0-5]\d)$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The stages of a scan that moves the parcel on towards a delivery.
const MOVING: ReadonlySet<Stage> = new Set(['in_transit', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup']);

/** A DPD parcel number: fourteen digits, or fourteen and their matching check character, looked up by the digits. */
export function normalizeDpdPtNumber(raw: string): string {
  const number = raw.length <= 64 ? dpdParcelNumber(normalizeTrackingNumber(raw)) : null;
  if (!number) throw new InvalidInputError(PROVIDER, 'DPD Portugal tracks fourteen-digit DPD parcel numbers, with or without their check character');
  return number;
}

/** A bot check or firewall page in place of the tracker. */
export function isDpdPtChallenge(html: string): boolean {
  return /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha|Request Rejected/i.test(html);
}

/** The scan's wall clock: the page gives a day and a time to the minute, without a zone. */
function wallClock(day: string, time: string): string {
  const date = DATE.exec(day);
  const clock = CLOCK.exec(time);
  // UTC only checks the calendar fields; the clock keeps no offset.
  const parsed = date && clock ? DateTime.fromObject({ year: Number(date[3]), month: Number(date[2]), day: Number(date[1]),
    hour: Number(clock[1]), minute: Number(clock[2]) }, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat('dd-MM-yyyy HH:mm') !== `${day} ${time}`) {
    throw new SchemaError(PROVIDER, 'DPD Portugal returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

interface Scan { code: string; comment: string; event: CarrierEvent }

/**
 * The point a parcel waits at, or was collected from: the pickup point's own
 * scan names it, when the parcel's last movement made it ready for pickup.
 */
function pickupPoint(newestFirst: readonly Scan[]): string | null {
  let skippedDelivery = false;
  for (const scan of newestFirst) {
    if (scan.event.stage_source === 'none') continue;
    if (scan.event.stage === 'delivered' && !skippedDelivery) {
      skippedDelivery = true;
      continue;
    }
    if (scan.event.stage !== 'ready_for_pickup') return null;
    if (scan.code === DPD_PT_POINT_RECEIPT && scan.comment) return scan.comment;
  }
  return null;
}

/**
 * The hour DPD's message gives the recipient on the delivery day (code 706), while that delivery
 * is still ahead: the message is the day's, and nothing after it but the van's scans and other
 * messages. A failed attempt, a return to the depot or a later day ends it.
 */
function deliveryWindow(newestFirst: readonly Scan[], stage: Stage | undefined): string | null {
  if (stage !== 'in_transit' && stage !== 'out_for_delivery') return null;
  const at = newestFirst.findIndex(scan => scan.code === DPD_PT_WINDOW);
  if (at < 0) return null;
  const message = newestFirst[at]!;
  const hours = WINDOW.exec(message.comment);
  const day = message.event.local_time!.slice(0, 10);
  if (!hours || hours[2]! <= hours[1]! || newestFirst[0]!.event.local_time!.slice(0, 10) !== day) return null;
  const ahead = newestFirst.slice(0, at).every(({ event }) => event.stage_source === 'none' || event.stage === 'out_for_delivery');
  return ahead ? `${day} ${hours[1]}–${hours[2]}` : null;
}

/**
 * The tracker's page for one reference: a heading naming the reference asked,
 * then either its not-found notice or the scans, newest first, in a table of
 * code, day, time, wording, comment and a map link.
 */
export function parseDpdPt(html: string, raw: string): CarrierResult {
  const number = normalizeDpdPtNumber(raw);
  const $ = load(html);
  const label = $('.reference-label');
  if (label.length !== 1) {
    if (isDpdPtChallenge(html)) throw new ChallengeError(PROVIDER, 'DPD Portugal answered with a browser check');
    throw new SchemaError(PROVIDER, 'DPD Portugal returned a page without a tracking answer');
  }
  const heading = clean(label.text(), 80);
  if (!heading.startsWith(LABEL)) throw new SchemaError(PROVIDER, 'DPD Portugal changed its tracking heading');
  if (heading.slice(LABEL.length).replace(/^\s*:/, '').trim() !== number) throw new IndeterminateError(PROVIDER, 'DPD Portugal answered for another parcel');
  const root = label.parent();

  const absent = root.find('.current-status-notfound');
  if (absent.length) {
    const notice = clean(absent.find('strong').first().text(), 120);
    if (NOT_FOUND.some(words => notice === `${words} ${number}`)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'DPD Portugal changed its not-found notice');
  }
  const table = root.find('table');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'DPD Portugal returned no history table');
  const headers = table.find('thead th').map((_, node) => clean($(node).text(), 40)).get();
  if (headers.join('|') !== HEADERS.join('|')) throw new SchemaError(PROVIDER, 'DPD Portugal history columns changed');
  const rows = table.find('tbody > tr');
  // The page answers a reference it holds no scans for with an empty table and no notice.
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DPD Portugal returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== HEADERS.length) throw new SchemaError(PROVIDER, 'DPD Portugal history columns changed');
    const code = clean(cells.eq(0).text(), 16).toUpperCase();
    const local_time = wallClock(clean(cells.eq(1).text(), 16), clean(cells.eq(2).text(), 16));
    const description = clean(cells.eq(3).text(), 200);
    if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'DPD Portugal returned an invalid scan code');
    if (!description) throw new SchemaError(PROVIDER, 'DPD Portugal returned a scan without wording');
    // Its day and time are when DPD set the expected day: as a step it would show a day the parcel was not due.
    if (code === DPD_PT_FORECAST) continue;
    // The comment column mixes the receiver's name, delivery windows, depot
    // and pickup point codes and references; only a pickup point's name and a
    // window message's hours are read.
    const comment = code === DPD_PT_POINT_RECEIPT || code === DPD_PT_WINDOW ? clean(cells.eq(4).text(), 120) : '';
    const key = JSON.stringify([local_time, code, description]);
    // The page lists some scans twice.
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ code, comment, event: { local_time, description, provider_code: code } });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Oldest first: a collection and a delivery take their stage from the scans
  // before them, a parcel sent back from the scans after it, and a notice keeps
  // the stage of the scan before it.
  const oldestFirst = [...scans].reverse();
  const moves = oldestFirst.map(({ code, event }) => MOVING.has(dpdPtStage(code, event.description!)?.stage as Stage));
  let previous: Stage | undefined;
  let returning = false;
  oldestFirst.forEach(({ code, event }, index) => {
    const movedOn = moves.includes(true, index + 1);
    // A proof of delivery that later scans take back, as the parcel back at
    // the depot to go out again, delivered nothing: like a notice, it keeps
    // the stage of the scan before it.
    if (isDpdPtNotice(code) || (code === DPD_PT_DELIVERY && !returning && movedOn)) {
      Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
      return;
    }
    const staged = dpdPtStage(code, event.description!);
    if (!staged) return;
    let stage = staged.stage;
    if (code === DPD_PT_COLLECTION && previous && previous !== 'registered') stage = 'in_transit';
    if (code === DPD_PT_DELIVERY && returning) stage = 'returned';
    if (code === DPD_PT_RETURNED && movedOn) stage = 'exception';
    if (code === DPD_PT_RETURN || code === DPD_PT_RETURNED) returning = true;
    Object.assign(event, { stage, stage_source: staged.source });
    previous = stage;
  });

  const events = scans.map(scan => scan.event);
  const decider = events.find(event => event.stage && event.stage_source !== 'none');
  // Once the parcel is sent back, it is a return under way, whatever the scans
  // on the way read, until a delivery reaches the sender.
  const read = decider?.stage as Stage | undefined;
  const stage = returning && read && read !== 'returned' ? 'exception' : read;
  const point = stage === 'ready_for_pickup' || stage === 'delivered' ? pickupPoint(scans) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: (decider ?? events[0]!).description!,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: deliveryWindow(scans, stage),
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
