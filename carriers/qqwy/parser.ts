import type { CarrierResult } from '../../core/result/index.js';
import { usStateTimeZone } from '../../core/time/index.js';
import { splitBytRow } from '../byt/parser.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { isQqwyNotice, qqwyEnglish, qqwyStage } from './status.js';

export const PROVIDER = 'Global Security';
export const QQWY_ORIGIN = 'http://www.qqwy56.com:8082';

// The Chinese copy the line's supplier writes after its rows: "Shoreline WA, Delivered(中文:Shoreline WA, Delivered)".
const CHINESE_COPY = /[(（]中文[:：]/;
// A US town and its state, with or without a comma and a ZIP code: "Bronx, NY 10459", "Seattle WA".
const US_TOWN = /^[A-Za-z][A-Za-z .'-]*?,?\s+([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/;
// The line's row naming the last-mile carrier's number.
const HAND_OFF = /^last mile, tracking number ([A-Z0-9]{6,40})$/i;

/**
 * The line's own rows, in China, at the airports and at its US gateway, are on the platform's
 * Beijing clock. A row copied from the last-mile carrier, placed at a US town, keeps its wall
 * clock: read on New York's, SpeedX's newest rows come within the hour before the platform writes
 * them, and read on Beijing's, UniUni's would predate polls that missed them. A row of the line's
 * supplier, which carries a Chinese copy, keeps its wall clock too: its receipt of an order comes
 * eight hours and a second after UniUni's, the same moment on a clock the record does not name.
 */
export function qqwyClock(row: HualeiRow): 'platform' | 'wall' {
  const town = US_TOWN.exec(row.location.trim());
  return CHINESE_COPY.test(row.content) || (town && usStateTimeZone(town[1])) ? 'wall' : 'platform';
}

/**
 * Global Security's (全球无忧, QQWY) tenant of the Hualei platform. Its US lines hand the parcel to
 * SpeedX or UniUni, whose number the record holds as its transfer number without naming the
 * carrier; the line's own row also names it.
 */
export const QQWY: HualeiTenant = {
  carrier: 'qqwy', provider: PROVIDER, origin: QQWY_ORIGIN, stage: qqwyStage, english: qqwyEnglish,
  split: splitBytRow, clock: qqwyClock, unlabelledPartners: ['speedx', 'uniuni'],
  handOff: (content) => HAND_OFF.exec(content.trim())?.[1],
  notice: (_code, wording) => isQqwyNotice(wording),
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseQqwyTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, QQWY, readAt);
export const parseQqwyPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, QQWY, readAt);
