import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { benbenStage } from './status.js';

export const PROVIDER = 'Benben';
export const BENBEN_ORIGIN = 'http://119.29.253.160:8082';

/**
 * Rows keep their wall clocks: the forwarder's own come from China and the destination, and the
 * delivering carrier's are copied on its facility's clock.
 */
export const BENBEN: HualeiTenant = { carrier: 'benben', provider: PROVIDER, origin: BENBEN_ORIGIN, stage: benbenStage, wallClocks: true };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseBenbenTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, BENBEN, readAt);
export const parseBenbenPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, BENBEN, readAt);
