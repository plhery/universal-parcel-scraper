import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { pengyouStage } from './status.js';

export const PROVIDER = 'Pengyou';
export const PENGYOU_ORIGIN = 'http://120.77.149.241:8082';
export const PENGYOU: HualeiTenant = { carrier: 'pengyou', provider: PROVIDER, origin: PENGYOU_ORIGIN, stage: pengyouStage };

export const normalizePengyouNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parsePengyouTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, PENGYOU, readAt);
export const parsePengyouPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, PENGYOU, readAt);
