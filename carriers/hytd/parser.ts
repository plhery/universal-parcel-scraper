import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { hytdStage } from './status.js';

export const PROVIDER = 'HYTD Express';
export const HYTD_ORIGIN = 'http://159.75.218.197:8082';

// A place with a town or a facility before its country's code: "DENVER, NC, US", "CHARLOTTE NC DISTRIBUTION CENTE, US".
const FACILITY = /\S\s*,\s*[A-Z]{2}$/;

/**
 * The line's own rows, placed at a country's code, at the line's own `HY` or nowhere, are on the
 * platform's Beijing clock, even the flight's landing written to the minute. A row placed at a town
 * or a facility is a scan the tracker copies from the delivering carrier, and keeps its wall clock:
 * the platform wrote USPS's delivery at a clock that falls in the night before on Beijing's clock.
 */
export const hytdClock = (row: HualeiRow): 'platform' | 'wall' => (FACILITY.test(row.location.trim()) ? 'wall' : 'platform');

/** A row without the line's own `HY` as its place, which names no place: the warehouse's receipt in China. */
export const splitHytdRow = (content: string, location: string): { content: string; location: string } =>
  ({ content, location: location.trim() === 'HY' ? '' : location });

/**
 * HYTD Express's (浩源拓达) tenant of the Hualei platform. Its own numbers are HY, twelve digits
 * and TD; once the delivering carrier's number has taken the record's tracking number, that number
 * is the delivery carrier's, without a channel name.
 */
export const HYTD: HualeiTenant = {
  carrier: 'hytd', provider: PROVIDER, origin: HYTD_ORIGIN, stage: hytdStage, split: splitHytdRow, clock: hytdClock,
  ownNumber: /^HY\d+TD$/,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseHytdTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, HYTD, readAt);
export const parseHytdPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, HYTD, readAt);
