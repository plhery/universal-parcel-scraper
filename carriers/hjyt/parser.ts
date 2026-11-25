import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { hjytStage } from './status.js';

export const PROVIDER = 'Hengjie Yutong';
export const HJYT_ORIGIN = 'http://120.78.64.88:8082';

/**
 * A row's wording without its place where the tracker writes the place again ahead of iMile's
 * category: "AUH DS Delivered,Your order has been delivered successfully." at "AUH DS".
 */
export function splitHjytRow(content: string, location: string): { content: string; location: string } {
  const place = location.trim();
  const text = content.trim();
  return place && text.toLowerCase().startsWith(`${place.toLowerCase()} `) ? { content: text.slice(place.length).trim(), location } : { content, location };
}

/**
 * The warehouse's rows, which carry a kind code, and the order's registration, placed nowhere,
 * are on the platform's Beijing clock. A row the tracker copies from iMile, placed at iMile's
 * centre, its station or the destination country, keeps iMile's wall clock there: iMile's own
 * tracker dates the same clocks in the United Arab Emirates, and iMile's order record comes two
 * seconds after the platform's registration on that clock, four hours behind Beijing's.
 */
export const hjytClock = (row: HualeiRow): 'platform' | 'wall' => (row.code || !row.location.trim() ? 'platform' : 'wall');

/**
 * Hengjie Yutong's (恒捷宇通, HJYT) tenant of the Hualei platform. Its line to the United Arab
 * Emirates hands the parcel to iMile, whose waybill is the record's tracking number; the
 * forwarder's own waybill stays in the invoice field.
 */
export const HJYT: HualeiTenant = {
  carrier: 'hjyt', provider: PROVIDER, origin: HJYT_ORIGIN, stage: hjytStage, split: splitHjytRow, clock: hjytClock,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseHjytTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, HJYT, readAt);
export const parseHjytPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, HJYT, readAt);
