import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { TOWN } from '../gzyl/status.js';
import { pengyouStage } from './status.js';

export const PROVIDER = 'Pengyou';
export const PENGYOU_ORIGIN = 'http://120.77.149.241:8082';

// The last-mile delivery, with its town after it: "Delivered Sample Town ST".
// A row's city after its wording, in brackets, square or full-width: "Arrived at facility [Shenzhen City]",
// "Handed over to the carrier for transportation【Hong Kong】".
const PLACED = /^(.*\S) ?(?:\[([^[\]]*\p{L}[^[\]]*)\]|【([^【】]*\p{L}[^【】]*)】)$/u;
const DELIVERED = /^(delivered) (\p{L}.*)$/iu;
// The postal code a delivery's town can end with, after a space or glued on: Canada's "A1A 1A1",
// the United Kingdom's "AA1A 1AA", a United States ZIP code, and four to six digits elsewhere.
const POSTCODE = /\s*(?:[A-Z]\d[A-Z] ?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|\d{5}-\d{4}|\d{4,6})$/iu;

/**
 * Pengyou writes a row's city after its wording, in brackets, and the town of a
 * last-mile delivery after its wording, and leaves the row's place empty. The
 * city or town becomes the place, a town without the recipient's postal code,
 * so a delivery reads the same for every town. A town that keeps a digit once
 * its postal code is cut stays in the wording.
 */
export function splitPengyouRow(content: string, location: string): { content: string; location: string } {
  const text = content.trim().split(/\s+/).join(' ');
  const placed = PLACED.exec(text);
  if (placed && !location.trim()) return { content: placed[1]!, location: (placed[2] ?? placed[3]!).trim() };
  const match = DELIVERED.exec(text);
  if (!match || location.trim()) return { content, location };
  const town = match[2]!.replace(POSTCODE, '').trim();
  if (!/^\p{Lu}/u.test(town) || /^(?:back|again|successfully)\b/i.test(town) || /\d/.test(town) || !TOWN.test(town)) return { content, location };
  return { content: match[1]!, location: town };
}

// Its scripts end, as GZYL's do, in a delivery row the platform writes in an evening batch on its own day.
export const PENGYOU: HualeiTenant = {
  carrier: 'pengyou', provider: PROVIDER, origin: PENGYOU_ORIGIN, stage: pengyouStage, split: splitPengyouRow, scriptedDelivery: true,
};

export const normalizePengyouNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parsePengyouTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, PENGYOU, readAt);
export const parsePengyouPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, PENGYOU, readAt);
