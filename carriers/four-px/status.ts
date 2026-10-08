import { classifyWording, languageStageStatus, type ClassifiedStatus, type Stage } from '../../core/status/index.js';

const CODES = new Map<string, ClassifiedStatus>([
  ['FPX_S_OK', { status: 'delivered', stage: 'delivered' }],
  ['FPX_D_SD', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['FPX_D_FD', { status: 'exception', stage: 'failed_attempt' }],
  ['FPX_L_RPIF', { status: 'pending', stage: 'registered' }],
  ['FPX_L_SC', { status: 'in_transit', stage: 'accepted' }],
  ['FPX_C_SPLS', { status: 'in_transit', stage: 'accepted' }],
  ['FPX_C_SPQS', { status: 'in_transit', stage: 'accepted' }],
  ['FPX_C_AAF', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_C_ADFF', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_F_ST', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_HA', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_DFOA', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_ATA', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_CRSD', { status: 'in_transit', stage: 'customs' }],
  ['FPX_I_RCUK', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_D_AOPC', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_D_STPP', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_D_HQ', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_O_RR', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_IT', { status: 'in_transit', stage: 'in_transit' }],
]);
// These codes relay whatever step a partner reported, from a label to an
// arrival in the destination country, so the wording decides the stage.
const WORDED = new Set(['FPX_O_IR', 'FPX_O_IRI']);
const WORDING: Readonly<Record<string, Stage>> = { 'Waybill generated': 'registered' };

export interface FourPxStatus extends ClassifiedStatus {
  source: string;
}

export function fourPxStatus(code: string, description = ''): FourPxStatus | undefined {
  const mapped = CODES.get(code);
  if (mapped) return { ...mapped, source: 'carrier_map' };
  if (!WORDED.has(code)) return undefined;
  const exact = WORDING[description];
  if (exact) return { status: languageStageStatus(exact), stage: exact, source: 'carrier_map' };
  const worded = classifyWording(description, 'pending');
  return worded.source === 'none' ? undefined : { status: languageStageStatus(worded.stage), stage: worded.stage, source: worded.source };
}
