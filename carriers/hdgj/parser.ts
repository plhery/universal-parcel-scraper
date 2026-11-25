import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { kunExpressClock, repeatsKunExpressRow, splitKunExpressRow } from '../kun-express/parser.js';
import { hdgjStage } from './status.js';

export const PROVIDER = 'Bright East International';
export const HDGJ_ORIGIN = 'http://134.175.244.145:8082';

// A row the forwarder writes with its country's code ahead of the wording and no place: "US,Customs clearance completed".
const COUNTRY_LEAD = /^([A-Z]{2})\s*,\s*(\S[\s\S]*)$/;

/**
 * A row that leads with its country's code and has no place of its own is placed in that country.
 * A row copied from USPS is cut as Kun Express cuts its copies: USPS's explanation after an arrow
 * and the place's ZIP code go.
 */
export function splitHdgjRow(content: string, location: string): { content: string; location: string } {
  const lead = location.trim() ? null : COUNTRY_LEAD.exec(content.trim());
  return lead ? { content: lead[2]!, location: lead[1]! } : splitKunExpressRow(content, location);
}

/**
 * Bright East International's (皓东国际, HDGJ) tenant of the Hualei platform. Its US line hands the
 * parcel to USPS under the record's transfer number, without a channel name, and the tracker
 * copies USPS's scans the way Kun Express's does: to the minute on the facility's clock, while the
 * forwarder's own rows come to the second on the platform's Beijing clock.
 */
export const HDGJ: HualeiTenant = {
  carrier: 'hdgj', provider: PROVIDER, origin: HDGJ_ORIGIN, stage: hdgjStage,
  split: splitHdgjRow, clock: kunExpressClock, repeats: repeatsKunExpressRow, unlabelledPartners: ['usps'],
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseHdgjTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, HDGJ, readAt);
export const parseHdgjPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, HDGJ, readAt);
