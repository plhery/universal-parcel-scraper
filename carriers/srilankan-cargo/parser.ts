import type { CarrierResult } from '../../core/result/index.js';
import { normalizeIcargoNeoWaybill, parseIcargoNeoTracking, type IcargoNeoPortal } from '../china-airlines-cargo/icargoNeo.js';
import { activityStage, activityWording } from './status.js';

export const provider = 'srilankan-cargo';

export const srilankanPortal: IcargoNeoPortal = {
  provider, name: 'SriLankan Cargo', prefix: '603', origin: 'https://srilankancargo.ibsplc.aero',
  activityStage, activityWording,
};

export const normalizeWaybill = (raw: string): string => normalizeIcargoNeoWaybill(raw, srilankanPortal);

export const parseTracking = (summaryBody: string, activityBody: string, waybill: string): CarrierResult =>
  parseIcargoNeoTracking(summaryBody, activityBody, waybill, srilankanPortal);
