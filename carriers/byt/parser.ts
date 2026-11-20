import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { bytStage } from './status.js';

export const PROVIDER = 'BYT';
// The tracker's HTTPS host; `byt56.com.cn:8082` serves the same tracker over plain HTTP.
export const BYT_ORIGIN = 'https://tms.byt56.com.cn';

// A copy BYT writes after some wordings, most often the English again: "The flight has landed(中文:The flight has landed)".
const CHINESE_COPY = /^([\s\S]*?)\s*[(（]中文[:：]([\s\S]*?)[)）]\s*$/;
// What the warehouse rows give for a place.
const NO_PLACE = /^the carrier$/i;
// The last-mile carrier's number, after the warehouse changes it: "…, the new tracking number is GFUS…".
const HAND_OFF = /\bthe new tracking number is ([A-Z0-9]{6,40})(?![A-Za-z0-9])/i;

/** A row's wording without its Chinese copy, unless the copy is all there is, and its place without the warehouse's placeholder. */
export function splitBytRow(content: string, location: string): { content: string; location: string } {
  const copy = CHINESE_COPY.exec(content);
  return { content: copy ? copy[1]!.trim() || copy[2]!.trim() : content, location: NO_PLACE.test(location.trim()) ? '' : location };
}

export const BYT: HualeiTenant = {
  carrier: 'byt', provider: PROVIDER, origin: BYT_ORIGIN, stage: bytStage, split: splitBytRow,
  handOff: (content) => HAND_OFF.exec(content)?.[1], unlabelledPartners: ['gofo'],
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseBytTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, BYT, readAt);
export const parseBytPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, BYT, readAt);
