import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { meitongdaStage } from './status.js';

export const PROVIDER = 'MEITONGDA';
export const MEITONGDA_ORIGIN = 'http://119.91.196.60:8082';

/**
 * The order's and the line's rows in China, placed nowhere, are on the platform's Beijing clock. A
 * row placed abroad, as the airport's and the delivering network's copies on the line to Britain,
 * keeps its station's wall clock: on Beijing's clock the Belfast delivery office would go out at
 * 01:38.
 */
export function meitongdaClock(row: HualeiRow): 'platform' | 'wall' {
  return row.location.trim() ? 'wall' : 'platform';
}

/**
 * MEITONGDA's (美通达) tenant of the Hualei platform. Its line to Britain copies the airport's and
 * the delivering network's scans into the record under the forwarder's own number, and names no
 * other number.
 */
export const MEITONGDA: HualeiTenant = {
  carrier: 'meitongda', provider: PROVIDER, origin: MEITONGDA_ORIGIN, stage: meitongdaStage, clock: meitongdaClock,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseMeitongdaTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, MEITONGDA, readAt);
export const parseMeitongdaPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, MEITONGDA, readAt);
