import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { kunExpressClock, repeatsKunExpressRow, splitKunExpressRow } from '../kun-express/parser.js';
import { gtiStage } from './status.js';

export const PROVIDER = 'GTI';
export const GTI_ORIGIN = 'http://gti568.com:8082';

// A space the tracker lost between two words of a copied USPS row: it writes `JAMAICA,?NY?11434`.
const LOST_SPACE = /(?<=\S)\?(?=\S)/gu;
// The comma a copied USPS row ends its category with, or all that is left of a row without one.
const EDGE_COMMAS = /^[\s,]+|[\s,]+$/gu;

/**
 * GTI's US line copies USPS's scans the way Kun Express's does, more than once, and some copies
 * lost their spaces to question marks. The spaces come back, the row is cut as Kun Express's is,
 * and the commas USPS's category leaves at its ends go. A row with no words but its place says
 * nothing and is dropped.
 */
export function splitGtiRow(content: string, location: string): { content: string; location: string } {
  const parts = splitKunExpressRow(content.replace(LOST_SPACE, ' '), location.replace(LOST_SPACE, ' '));
  const text = parts.content.replace(EDGE_COMMAS, '');
  return text ? { content: text, location: parts.location } : { content: '', location: '' };
}

/**
 * The forwarder's own rows come to the second on the platform's Beijing clock, USPS's to the
 * minute on the facility's, so the rows are read as Kun Express reads them.
 */
export const GTI: HualeiTenant = {
  carrier: 'gti', provider: PROVIDER, origin: GTI_ORIGIN, stage: gtiStage,
  split: splitGtiRow, clock: kunExpressClock, repeats: repeatsKunExpressRow,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseGtiTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, GTI, readAt);
export const parseGtiPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, GTI, readAt);
