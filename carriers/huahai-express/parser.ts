import type { CarrierResult } from '../../core/result/index.js';
import { classifyWording } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { dateHualeiGofoRows, isHualeiUsPartnerRow } from '../gzyl/gofo-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { huahaiStage } from './status.js';

export const PROVIDER = 'Huahai Express';
export const HUAHAI_ORIGIN = 'http://119.45.241.73:8082';

// The flight's landing, the line's first row written abroad: in the United States, or at Incheon on the line through Korea.
const LANDED = /^(?:international flight has arrived|the goods arrived at the airport in .+)$/i;
// A row the line places in a country rather than a town, as its rows in the United States before GOFO's.
const ABROAD = /^(?!CN$)[A-Z]{2}$/;

/**
 * The line's rows in China are on the platform's Beijing clock. From the flight's landing on, the
 * line writes its rows on its destination's wall clock: read on Beijing's, a flight that left at
 * 08:55 would land at 11:20 the same morning. So do the rows placed in a country rather than a
 * town, and GOFO's, which `dateHualeiGofoRows` then dates on GOFO's clocks.
 */
export function huahaiClock(row: HualeiRow, rows: readonly HualeiRow[]): 'platform' | 'wall' {
  if (isHualeiUsPartnerRow(row.content, row.location) || ABROAD.test(row.location.trim())) return 'wall';
  const landed = rows.filter(({ content }) => LANDED.test(content.trim())).map(({ clock }) => clock).sort()[0];
  return landed !== undefined && row.clock >= landed ? 'wall' : 'platform';
}

/**
 * USPS's scans reach the tracker twice, as their headline alone and with more after an arrow or a
 * comma ("Arrived at USPS Facility -> Your item arrived at our USPS facility in …", "Out for
 * Delivery, Expected Delivery by 9:00pm"): the headline alone is that scan again when both give one
 * stage, and the fuller row stays.
 */
export function repeatsHuahaiRow(wording: string, other: string): boolean {
  const [headline, fuller] = [normalizeStatusWording(wording), normalizeStatusWording(other)];
  const stage = huahaiStage(null, headline) ?? classifyWording(headline, 'pending').stage;
  return (fuller.startsWith(`${headline} -> `) || fuller.startsWith(`${headline}, `))
    && (huahaiStage(null, fuller) ?? classifyWording(fuller, 'pending').stage) === stage;
}

/**
 * Huahai's (杭州花海供应链) tenant of the Hualei platform. Its lines into the United States end
 * with GOFO, UniUni or USPS, whose scans the tracker copies into the record under Huahai's own
 * number, which is the record's tracking number too.
 */
export const HUAHAI: HualeiTenant = {
  carrier: 'huahai-express', provider: PROVIDER, origin: HUAHAI_ORIGIN, stage: huahaiStage, clock: huahaiClock, repeats: repeatsHuahaiRow,
};

/** The track interface's reply, or null when it holds no row for the number. */
export function parseHuahaiTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, HUAHAI, readAt);
  return result && dateHualeiGofoRows(result);
}
export const parseHuahaiPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateHualeiGofoRows(parseHualeiPage(html, number, HUAHAI, readAt));
