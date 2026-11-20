import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { tuomeidaStage } from './status.js';

export const PROVIDER = 'Tuomeida';
export const TUOMEIDA_ORIGIN = 'http://114.132.187.44:8082';

/**
 * Rows keep their wall clocks: the forwarder's own come from China and the destination, and the
 * delivering carrier's are copied on its facility's clock.
 */
export const TUOMEIDA: HualeiTenant = { carrier: 'tuomeida', provider: PROVIDER, origin: TUOMEIDA_ORIGIN, stage: tuomeidaStage, wallClocks: true };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseTuomeidaTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, TUOMEIDA, readAt);
export const parseTuomeidaPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, TUOMEIDA, readAt);
