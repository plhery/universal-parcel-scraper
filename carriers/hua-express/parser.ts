import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { huaExpressStage } from './status.js';

export const PROVIDER = 'HUA Express';
export const HUA_EXPRESS_ORIGIN = 'http://159.75.210.47:8082';

/**
 * Rows keep their wall clocks: the forwarder's own come from China and the destination, and the
 * delivering carrier's are copied on its facility's clock.
 */
export const HUA_EXPRESS: HualeiTenant = { carrier: 'hua-express', provider: PROVIDER, origin: HUA_EXPRESS_ORIGIN, stage: huaExpressStage, wallClocks: true };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseHuaExpressTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, HUA_EXPRESS, readAt);
export const parseHuaExpressPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, HUA_EXPRESS, readAt);
