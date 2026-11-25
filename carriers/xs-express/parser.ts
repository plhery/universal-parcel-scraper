import type { CarrierResult } from '../../core/result/index.js';
import { countryCode } from '../../core/time/index.js';
import { escapeRegExp } from '../../core/transport/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { kunExpressClock } from '../kun-express/parser.js';
import { xsExpressStage } from './status.js';

export const PROVIDER = 'Xinshu Logistics';
export const XS_EXPRESS_ORIGIN = 'http://tms.xs-exp.com:8082';

// A country's name ahead of the line's own wording: "China,Departed from sorting center".
const COUNTRY_LEAD = /^([^,，]+)[,，]\s*(\S[\s\S]*)$/u;

/**
 * The line's own rows lead with their country's name, which goes: the row's place names the town.
 * The rows copied from USPS end with their place in full, the town, state and ZIP code, where the
 * place field can hold the town alone: the wording ends where the place starts, and that whole
 * place is the row's, its ZIP code dropped by the shared cleaning.
 */
export function splitXsExpressRow(content: string, location: string): { content: string; location: string } {
  const text = content.trim();
  const lead = COUNTRY_LEAD.exec(text);
  if (lead && countryCode(lead[1]!)) return { content: lead[2]!, location };
  const place = location.trim();
  const tail = place ? new RegExp(`^([\\s\\S]*\\S)\\s+(${escapeRegExp(place)}(?:\\s[\\s\\S]*)?)$`, 'iu').exec(text) : null;
  return tail ? { content: tail[1]!, location: tail[2]! } : { content: text, location };
}

/**
 * Xinshu Logistics's (新树物流, XS Express) tenant of the Hualei platform. Its own numbers are XSECN,
 * digits and YQ; on its US line USPS's number takes the record's tracking number, without a channel
 * name. The tracker copies USPS's scans the way Kun Express's does: to the minute on the facility's
 * clock, while the line's own rows come to the second on the platform's Beijing clock.
 */
export const XS_EXPRESS: HualeiTenant = {
  carrier: 'xs-express', provider: PROVIDER, origin: XS_EXPRESS_ORIGIN, stage: xsExpressStage,
  split: splitXsExpressRow, clock: kunExpressClock, ownNumber: /^XSECN\d+YQ$/, unlabelledPartners: ['usps'],
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseXsExpressTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, XS_EXPRESS, readAt);
export const parseXsExpressPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, XS_EXPRESS, readAt);
