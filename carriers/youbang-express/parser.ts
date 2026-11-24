import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { youbangExpressStage } from './status.js';

export const PROVIDER = 'YouBang Express';
export const YOUBANG_EXPRESS_ORIGIN = 'http://119.29.254.121:8082';

// The warehouse writes "." for the place of its own rows.
const NO_PLACE = /^[^\p{L}\p{N}]*$/u;

/** A row's wording, and its place unless the place holds no letter or digit. */
export function splitYoubangExpressRow(content: string, location: string): { content: string; location: string } {
  return { content, location: NO_PLACE.test(location) ? '' : location };
}

/** Rows are read on the platform's Beijing clock. */
export const YOUBANG_EXPRESS: HualeiTenant = {
  carrier: 'youbang-express', provider: PROVIDER, origin: YOUBANG_EXPRESS_ORIGIN, stage: youbangExpressStage, split: splitYoubangExpressRow,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseYoubangExpressTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, YOUBANG_EXPRESS, readAt);
export const parseYoubangExpressPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, YOUBANG_EXPRESS, readAt);
