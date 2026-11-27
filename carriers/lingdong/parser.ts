import type { CarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { dateHualeiGofoRows, isHualeiUsPartnerRow } from '../gzyl/gofo-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { isLingdongArrivalForecast, isLingdongEmptyRow, isLingdongFlightBooked, lingdongEnglish, lingdongStage } from './status.js';

export const PROVIDER = 'Lingdong International';
export const LINGDONG_ORIGIN = 'http://tms.lingdong56.com:8082';

/**
 * The tracker can list a delivery partner's scan twice at one clock and place: its headline alone
 * and with the partner's sentence after a comma ("In transito" and "In transito, la spedizione è in
 * transito"). The headline alone is that scan again when both give one stage; the fuller row stays.
 */
export function repeatsLingdongRow(wording: string, other: string): boolean {
  const [headline, fuller] = [normalizeStatusWording(wording), normalizeStatusWording(other)];
  const stage = lingdongStage(null, headline);
  return fuller.startsWith(`${headline}, `) && stage !== undefined && lingdongStage(null, fuller) === stage;
}

// The line into the United States ends with GOFO, whose scans the tracker copies on GOFO's clocks, as JRT's does.
// A row in Chinese and then in English shows its English half.
// The flight booked for the parcel, before it flies ("Expected flight on Nov. 19th"), and its expected landing once it
// flies are forecasts, not movements, and a row of punctuation alone names nothing: notices on the stage of the scan before them.
export const LINGDONG: HualeiTenant = { carrier: 'lingdong', provider: PROVIDER, origin: LINGDONG_ORIGIN, stage: lingdongStage,
  english: (_code, _wording, shown) => lingdongEnglish(shown), repeats: repeatsLingdongRow, ownNumber: /^SZLD\d{10}$/,
  clock: ({ content, location }) => (isHualeiUsPartnerRow(content, location) ? 'wall' : 'platform'),
  notice: (_code, wording) => isLingdongFlightBooked(wording) || isLingdongArrivalForecast(wording) || isLingdongEmptyRow(wording) };

/** The track interface's reply, or null when it holds no row for the number. */
export function parseLingdongTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, LINGDONG, readAt);
  return result && dateHualeiGofoRows(result);
}
export const parseLingdongPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateHualeiGofoRows(parseHualeiPage(html, number, LINGDONG, readAt));
