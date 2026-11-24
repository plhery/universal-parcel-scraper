import type { CarrierResult } from '../../core/result/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { edPostEnglish, edPostStage, isEdPostCopiedRow, isEdPostDhlGermanRow, isEdPostDhlRow, isEdPostNotice } from './status.js';

export const PROVIDER = 'ED POST';
// The tracker the site's header links to; its tracking page reaches the same one through `/sz56t` on port 80.
export const ED_POST_ORIGIN = 'http://www.666post.com:8082';

// The status the tracker glues to the end of a row it copies from DHL: "…to DHLtransit".
const GLUED_STATUS = /(?<=\S)transit$/i;

/** A row's wording without the status the tracker glues to the rows it copies from DHL. */
export function splitEdPostRow(content: string, location: string): { content: string; location: string } {
  return { content: isEdPostDhlRow(content) ? content.replace(GLUED_STATUS, '') : content, location };
}

/**
 * The forwarder's own rows are on the platform's Beijing clock. The rows it copies from the delivery carrier, DHL's
 * and GOFO's, keep that carrier's wall clock: GOFO's label row reads exactly seven hours before the order's
 * registration, which is Amsterdam's clock for the same moment.
 */
export function edPostClock({ content }: HualeiRow): 'platform' | 'wall' {
  return isEdPostCopiedRow(content) ? 'wall' : 'platform';
}

/**
 * ED POST's tenant of the Hualei platform. Its own numbers start `YD` and end `YQ`; the record's tracking number is
 * the delivery carrier's, GOFO's in the Netherlands or DHL's in Germany, without a channel name.
 */
export const ED_POST: HualeiTenant = {
  carrier: 'ed-post', provider: PROVIDER, origin: ED_POST_ORIGIN, stage: edPostStage, english: edPostEnglish,
  split: splitEdPostRow, clock: edPostClock, ownNumber: /^YD[A-Z]+\d+YQ$/, unlabelledPartners: ['gofo-nl', 'dhl'],
  notice: (_code, wording) => isEdPostNotice(wording),
};

/** The result with the rows the tracker copies from DHL dated, each keeping its wall clock. */
export const dateEdPostDhlRows = (result: CarrierResult): CarrierResult =>
  dateDhlRows(result, { isRow: isEdPostDhlRow, isGermanRow: isEdPostDhlGermanRow });

/** The track interface's reply, or null when it holds no row for the number. */
export function parseEdPostTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, ED_POST, readAt);
  return result && dateEdPostDhlRows(result);
}

export const parseEdPostPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateEdPostDhlRows(parseHualeiPage(html, number, ED_POST, readAt));
