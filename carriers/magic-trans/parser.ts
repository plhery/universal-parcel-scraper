import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { MILESTONES, magicTransStage } from './status.js';

export const PROVIDER = 'Magic Trans';
export const MAX_BYTES = 64_000;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const HEADING = /^Статус груза(?:\s+(\S+))?$/;
// The page's empty status: no cargo by that number.
const NONE = new Set(['', '--']);

/** An act number, nine digits with leading zeros, or the TR…MT track number the tracker's own example shows. */
export function normalizeMagicTransNumber(raw: string): string {
  const number = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^(?:\d{9}|TR\d{9}MT)$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

function unreadable(what: string): SchemaError {
  return new SchemaError(PROVIDER, `Magic Trans returned an unreadable ${what}`);
}

/** A day the page writes as DD.MM.YYYY; its accounting system writes an unset one as 01.01.0001. */
function dayOf(value: unknown): string | undefined {
  const match = DAY.exec(clean(value, 40));
  if (!match || Number(match[3]) < 2000) return undefined;
  const [, d, m, y] = match;
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) throw unreadable('date');
  return `${y}-${m}-${d}`;
}

function clockOf(value: unknown): string | undefined {
  const match = CLOCK.exec(clean(value, 40));
  if (!match || Number(match[3]) < 2000) return undefined;
  const [, d, m, y, hh, mm, ss] = match;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) throw unreadable('time');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
}

interface Scan { rank: number; event: CarrierEvent & { local_time: string; description: string }; stage?: Stage; source?: string }

function scan(rank: number, code: string, local_time: string, location: string): Scan {
  const classified = magicTransStage(code, '');
  return {
    rank,
    event: { local_time, description: MILESTONES.get(code)!, ...(location ? { location } : {}), provider_code: code,
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) },
    ...(classified ? { stage: classified.stage, source: classified.source } : {}),
  };
}

/**
 * The tracker's result for one number: its cargo status and the days the page shows for the handover at
 * the departure terminal, the arrival at the receiving terminal and the issue there, each a date without
 * a zone. The record the page prints in a hidden block adds the act's time, the terminals' cities and
 * whether the arrival happened rather than being planned.
 */
export function parseMagicTrans(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || payload.wrapper !== true || !Array.isArray(payload.rows) || typeof payload.heading !== 'string') {
    throw unreadable('page');
  }
  if (payload.rows.length > 20) throw unreadable('page');
  const rows = new Map<string, string>();
  for (const row of payload.rows) {
    if (!isRecord(row) || typeof row.key !== 'string' || typeof row.value !== 'string') throw unreadable('row');
    if (row.hidden !== true && !rows.has(row.key)) rows.set(row.key, clean(row.value, 160));
  }
  const dump = isRecord(payload.dump) ? payload.dump : undefined;
  const text = (key: string): string => (dump ? clean(dump[key], 120) : '');
  const status = rows.get('Статус груза') ?? '';
  const heading = HEADING.exec(clean(payload.heading, 80));
  if (!heading) throw unreadable('heading');
  const shown = heading[1];
  if (!shown) {
    // The page's empty template: a heading without a number and no cargo in it.
    if (!NONE.has(status) || text('ActNumber') || text('TrackNumber')) throw new SchemaError(PROVIDER, 'Magic Trans did not name the cargo');
    throw new NotFoundError(PROVIDER);
  }
  if (![shown, text('ActNumber'), text('TrackNumber')].includes(number)) {
    throw new SchemaError(PROVIDER, 'Magic Trans answered for another number');
  }
  const handover = dayOf(rows.get('Дата сдачи груза') ?? text('DateDeparture'));
  // The record keeps the planned arrival apart; the row is read only when the record is missing.
  const arrival = dump ? dayOf(dump.DateArrivalWarehouseRecipient) : dayOf(rows.get('Прибытие груза на терминал'));
  const issue = dayOf(rows.get('Дата выдачи груза') ?? text('DateOfIssue'));
  const estimate = dayOf(rows.get('Ориентировочная дата выдачи') ?? text('EstimatedDateOfReceiptOfShipment'));
  const act = clockOf(text('DateTimeAct'));
  const scans: Scan[] = [];
  if (handover) scans.push(scan(0, 'handover', act?.startsWith(handover) ? act : handover, text('SenderWareHouse')));
  if (arrival) scans.push(scan(1, 'arrival', arrival, text('ReceiverWareHouse')));
  if (issue) scans.push(scan(2, 'issue', issue, text('ReceiverWareHouse')));
  if (!scans.length) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  // Newest first by day, then by the order the page lists the rows in.
  scans.sort((a, b) => b.event.local_time.slice(0, 10).localeCompare(a.event.local_time.slice(0, 10)) || b.rank - a.rank);
  const events = scans.map(one => one.event);
  const newest = scans[0]!;
  const said = NONE.has(status) ? null : magicTransStage(undefined, status);
  const stage = said?.stage ?? newest.stage;
  const source = said ? said.source : newest.source;
  const settled = stage === 'delivered' || stage === 'returned' || !!issue;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: NONE.has(status) ? newest.event.description : status,
    last_update: null,
    last_update_local: newest.event.local_time,
    expected_delivery: !settled && estimate ? estimate : null,
    events,
  };
}
