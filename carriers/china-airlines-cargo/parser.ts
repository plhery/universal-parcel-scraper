import type { CarrierResult } from '../../core/result/index.js';
import { normalizeIcargoNeoWaybill, parseIcargoNeoTracking, type IcargoNeoPortal } from './icargoNeo.js';
import { activityStage, activityWording } from './status.js';

export const provider = 'china-airlines-cargo';

export const chinaAirlinesPortal: IcargoNeoPortal = {
  provider, name: 'China Airlines Cargo', prefix: '297', origin: 'https://icargowebportal.china-airlines.com',
  activityStage, activityWording,
};

export const normalizeWaybill = (raw: string): string => normalizeIcargoNeoWaybill(raw, chinaAirlinesPortal);

export const parseTracking = (summaryBody: string, activityBody: string, waybill: string): CarrierResult =>
  parseIcargoNeoTracking(summaryBody, activityBody, waybill, chinaAirlinesPortal);
