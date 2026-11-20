import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { feimaStage } from './status.js';

export const PROVIDER = 'Feima';
export const FEIMA_ORIGIN = 'http://47.111.22.87:8082';
export const FEIMA: HualeiTenant = { carrier: 'feima', provider: PROVIDER, origin: FEIMA_ORIGIN, stage: feimaStage };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseFeimaTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, FEIMA, readAt);
export const parseFeimaPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, FEIMA, readAt);
