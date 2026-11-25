import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { qyunStage } from './status.js';

export const PROVIDER = 'Qyun Express';
export const QYUN_ORIGIN = 'http://106.52.192.65:8082';

// iMile's category, which the tracker writes ahead of the row it copies: "scan Abnormal LT", "submitted Order Submited.".
const CATEGORY = /^\s*(?:scan|submitted)\s+/i;
// A clock on the whole hour, which the line writes by hand.
const WHOLE_HOUR = /\s\d{2}:00:00$/;

/** A row's wording without the category iMile's copied rows open with. */
export function splitQyunRow(content: string, location: string): { content: string; location: string } {
  return { content: content.replace(CATEGORY, ''), location };
}

/**
 * Rows are on the platform's Beijing clock, iMile's copied ones included: iMile dates the same
 * delivery in Guadalajara fourteen hours earlier on Mexico's clock. The line's airport and customs
 * rows, written by hand on the whole hour, give their day alone: they land on midnight, or are
 * written in the morning for noon and the afternoon at Hong Kong.
 */
export const qyunClock = (row: HualeiRow): 'platform' | 'day' => (WHOLE_HOUR.test(row.clock.trim()) ? 'day' : 'platform');

/**
 * Qyun Express's (青云物流) tenant of the Hualei platform. Its lines to Mexico hand the parcel to
 * iMile, whose waybill is the record's tracking number.
 */
export const QYUN: HualeiTenant = {
  carrier: 'qyun', provider: PROVIDER, origin: QYUN_ORIGIN, stage: qyunStage, split: splitQyunRow, clock: qyunClock,
};

/**
 * The result without a row iMile's feed writes again without the warehouse's kind code: the same
 * clock, wording and place as a coded row.
 */
export function withoutCopies(result: CarrierResult): CarrierResult {
  const events = result.events ?? [];
  const key = (event: (typeof events)[number]) => JSON.stringify([event.time ?? event.local_time, event.description, event.location]);
  const coded = new Set(events.filter((event) => event.provider_code).map(key));
  const kept = events.filter((event) => event.provider_code || !coded.has(key(event)));
  return kept.length === events.length ? result : { ...result, events: kept };
}

/** The track interface's reply, or null when it holds no row for the number. */
export function parseQyunTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, QYUN, readAt);
  return result && withoutCopies(result);
}
export const parseQyunPage = (html: string, number: string, readAt?: number): CarrierResult =>
  withoutCopies(parseHualeiPage(html, number, QYUN, readAt));
