import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { rmLogisticsStage } from './status.js';

export const PROVIDER = 'RM Logistics';
export const RM_LOGISTICS_ORIGIN = 'http://129.211.2.64:8082';

/**
 * Rows keep their wall clocks: the forwarder's own come from China and the destination, and the
 * delivering carrier's are copied on its facility's clock.
 */
export const RM_LOGISTICS: HualeiTenant = { carrier: 'rm-logistics', provider: PROVIDER, origin: RM_LOGISTICS_ORIGIN, stage: rmLogisticsStage, wallClocks: true };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseRmLogisticsTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, RM_LOGISTICS, readAt);
export const parseRmLogisticsPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, RM_LOGISTICS, readAt);
