import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { e2gStage, statusMap } from './status.js';

export const PROVIDER = 'E2G Express';
export const CARRIER = 'express2global';
// A waybill's reply is a few kilobytes.
export const E2G_MAX_BYTES = 256 * 1024;
// The firm's waybills: E2G or two letters, nine digits and US. The tracker answers other text, a name or a phone
// for instance, with the members' orders that match it, so nothing else is sent.
const NUMBER = /^(?:E2G|[A-Z]{2})\d{9}US$/;
// The newer waybills are two letters, the system's waybill id and US.
const ID_NUMBER = /^[A-Z]{2}(\d{9})US$/;
const ZONE = 'Asia/Shanghai';
// "2025-03-19 11:06:15": the server's wall clock, China's.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// "…/顺丰速运/SF…", "…/中通国际/…；…": the courier in China and its number, in the row for the hand-off.
const HANDOFF = /(?:^|\/)([^/]{2,10})\/([A-Za-z0-9]{8,30})(?=$|[；;，,。\s])/u;
// Couriers in China a waybill may hand the parcel to, as Chinese names them, with the catalog's id.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'], [/京东/u, 'jd-logistics'],
  [/极兔/u, 'j-and-t-cn'], [/德邦/u, 'deppon'], [/邮政|EMS/iu, 'china-post'],
];
// A part of a row that would name a person or a phone.
const CONTACT = /(?<![\dA-Za-z])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?!\d)|签收人|收件人|电话|手机/u;
const MAX_ROWS = 300;

interface Row {
  readonly WbId?: unknown;
  readonly Remark?: unknown;
  readonly Createtime?: unknown;
}

/** A waybill number on the firm's tracker, without spaces or hyphens. */
export function normalizeE2gNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'E2G Express waybills are E2G or two letters, nine digits and US');
  return number;
}

/** A row's text, without any part between slashes that would name a person or a phone. */
export function e2gText(raw: string): string {
  return clean(raw, 500).split('/').map((part) => part.trim()).filter((part) => part && !CONTACT.test(part)).join('/');
}

function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

/** The courier in China a row names with its number, when the number is that courier's and not the waybill's. */
function handoffOf(text: string, number: string): { carrier: string; number: string } | null {
  const match = HANDOFF.exec(text);
  if (!match) return null;
  const named = COURIERS.filter(([pattern]) => pattern.test(match[1]!));
  const onward = normalizeTrackingNumber(match[2]!);
  if (named.length !== 1 || onward === number) return null;
  const carrier = named[0]![1];
  return (detectCarrierMatch(onward).candidates as string[]).includes(carrier) ? { carrier, number: onward } : null;
}

/** The rows of the reply `{status, data}`, whose `data` is itself JSON: `{total, rows, other}`. */
function rowsOf(body: string): unknown[] {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable reply`);
  }
  if (!reply || typeof reply !== 'object') throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable reply`);
  const { status, data } = reply as { status?: unknown; data?: unknown };
  // Any other status carries a list of members' orders, which is not a waybill's history and is not read.
  if (status !== 'y') throw new IndeterminateError(PROVIDER, `${PROVIDER} did not answer with a waybill's history`);
  let history: unknown;
  try {
    history = typeof data === 'string' && data ? JSON.parse(data) : null;
  } catch {
    history = null;
  }
  const rows = history && typeof history === 'object' ? (history as { rows?: unknown }).rows : undefined;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  return rows;
}

/**
 * The firm's history for one waybill from `track/tracking`: JSON whose `data` is a JSON string of rows, oldest
 * first, each a waybill id, a text and the server's wall clock. A history without rows is the tracker's only
 * answer for a waybill it does not know. The reply does not name the number it answered for: every row must share
 * one waybill id, which is the number's digits on the newer waybills. The server's clock is China's; a clock that
 * would date a row after the lookup keeps its wall clock alone. The hand-off row names the courier in China with
 * its number.
 */
export function parseE2g(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeE2gNumber(raw);
  const rows = rowsOf(body);
  if (!rows.length) throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill with this number`);
  if (!rows.every((row) => row && typeof row === 'object')) throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable row`);
  const ids = new Set((rows as Row[]).map(({ WbId: value }) => (typeof value === 'number' || typeof value === 'string' ? String(value) : '')));
  const id = ID_NUMBER.exec(number)?.[1];
  if (ids.size !== 1 || !/^\d{1,12}$/.test([...ids][0]!) || (id && !ids.has(id))) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered for another waybill`);
  }
  const seen = new Set<string>();
  const read: CarrierEvent[] = [];
  let handoff: { carrier: string; number: string } | null = null;
  for (const row of rows as Row[]) {
    const local = wallClock(row.Createtime);
    if (typeof row.Remark !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable row`);
    const description = e2gText(row.Remark);
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    handoff = handoffOf(description, number) ?? handoff;
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
    const staged = e2gStage(description);
    read.push({
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  // The reply lists the rows oldest first.
  const events = read.reverse();
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    // The firm ships from the US to China only.
    origin_country: 'US',
    destination_country: 'CN',
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}
