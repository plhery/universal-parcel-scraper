import type { HualeiRow, HualeiTenant } from '../gzyl/hualei.js';
import { anhuaEnglish, anhuaStage, isAnhuaNotice } from './status.js';

export const PROVIDER = 'Anhua International';
export const ANHUA_ORIGIN = 'http://www.ahgjgyl.com:8082';

// Australia Post's delivery row names who signed: "Delivered Left with concierge/reception with signature from …".
const SIGNATURE = /\s*\bwith signature from\b[\s\S]*$/i;

/** A row's wording without the name of whoever signed for the parcel. */
export function splitAnhuaRow(content: string, location: string): { content: string; location: string } {
  return { content: content.replace(SIGNATURE, ''), location };
}

/** A row the line copies from Australia Post that names it, as its approval of the shipping data. */
export const isAnhuaAustraliaPostRow = (row: HualeiRow): boolean => !row.code && /\bAustralia Post\b/i.test(row.content);

/**
 * Anhua's (广州安华国际供应链管理有限公司) tenant of the Hualei platform. Its line to Australia
 * hands the parcel to Australia Post, whose article id is the record's tracking number and whose
 * scans it copies on the platform's Beijing clock; Anhua's own waybill stays in the invoice field.
 */
export const ANHUA: HualeiTenant = {
  carrier: 'anhua-international', provider: PROVIDER, origin: ANHUA_ORIGIN, stage: anhuaStage, english: anhuaEnglish,
  split: splitAnhuaRow, notice: (_code, wording) => isAnhuaNotice(wording),
  copiedPartner: { carrier: 'australia-post', copies: isAnhuaAustraliaPostRow },
};
