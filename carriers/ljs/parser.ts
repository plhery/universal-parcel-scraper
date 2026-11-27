import type { HualeiRow, HualeiTenant, HualeiZoneClock } from '../gzyl/hualei.js';
import { isLjsFlightBooking, ljsEnglish, ljsStage } from './status.js';

export const PROVIDER = 'LJS International Freight';
export const LJS_ORIGIN = 'http://115.29.184.71:8082';

// Sagawa's steps as the line copies them from Sagawa's page: each after an arrow, the newest after "⇒",
// which the track interface, in GBK, gives as a question mark. Each names Sagawa's office or hub.
const SAGAWA_STEP = /^[↓⇒?]\s*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const SAGAWA_PLACE = /(?:営業所|センター)$/u;
// Sagawa's summary of the parcel, its piece count with its offices' telephone and fax numbers as the place.
const SAGAWA_SUMMARY = /^\d+個$/u;
const ARROW = /^(?:[↓⇒]|\?(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]))\s*/u;
const JAPAN_CLOCK: HualeiZoneClock = { zone: 'Asia/Tokyo', basis: 'carrier' };

/** Whether a row is one of Sagawa's steps, which the line copies under Sagawa's own number. */
export const isLjsSagawaRow = ({ code, content, location }: HualeiRow): boolean =>
  !code && SAGAWA_STEP.test(content.trim()) && SAGAWA_PLACE.test(location.trim());

/** A Sagawa step without its arrow; Sagawa's summary row goes, its place being two offices' telephone numbers. */
export function splitLjsRow(content: string, location: string): { content: string; location: string } {
  if (SAGAWA_SUMMARY.test(content.trim())) return { content: '', location: '' };
  return { content: content.trim().replace(ARROW, ''), location };
}

/**
 * A row's clock. Sagawa's steps are on Japan's clock: the delivery row was written at 10:22 on
 * Beijing's clock and reads 10:48, which only Japan's clock, an hour ahead, puts before it was
 * written. The line's own rows, up to the flight's landing, are on the platform's Beijing clock.
 */
export const ljsClock = (row: HualeiRow): 'platform' | HualeiZoneClock => (isLjsSagawaRow(row) ? JAPAN_CLOCK : 'platform');

/**
 * LJS's (深圳利佳顺国际货运) tenant of the Hualei platform. On its line to Japan the record's tracking
 * number is Sagawa's, whose steps the line copies; LJS's own number is the invoice number.
 */
export const LJS: HualeiTenant = {
  carrier: 'ljs', provider: PROVIDER, origin: LJS_ORIGIN, stage: ljsStage, english: ljsEnglish,
  split: splitLjsRow, clock: ljsClock, copiedPartner: { carrier: 'sagawa', copies: isLjsSagawaRow },
  notice: (_code, wording) => isLjsFlightBooking(wording), bareUnknownPage: true,
};
