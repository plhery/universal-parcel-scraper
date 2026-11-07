import type { CarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { lingdongStage } from './status.js';

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

export const LINGDONG: HualeiTenant = { carrier: 'lingdong', provider: PROVIDER, origin: LINGDONG_ORIGIN, stage: lingdongStage,
  repeats: repeatsLingdongRow };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseLingdongTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, LINGDONG, readAt);
export const parseLingdongPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, LINGDONG, readAt);
