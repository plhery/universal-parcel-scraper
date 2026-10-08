import type { ClassifiedStatus } from '../../core/status/index.js';

// The public website's SendungenApiSchemasExtension distinguishes the summary
// vocabulary from scan codes: a delivered scan can still carry status IZ.
const SUMMARY: Record<string, ClassifiedStatus> = {
  AV: { status: 'pending', stage: 'registered' },
  AN: { status: 'in_transit', stage: 'accepted' },
  IV: { status: 'in_transit', stage: 'in_transit' },
  IZ: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  EB: { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  RE: { status: 'exception', stage: 'returned' },
  ZU: { status: 'delivered', stage: 'delivered' },
};

export function austrianPostSummaryStatus(code: string): ClassifiedStatus | undefined {
  return SUMMARY[code];
}

// The reasons for which the tracking page shows a delay (its Verzoegerung
// list) or a problem to resolve (Rufzeichen) instead of the estimate.
const ESTIMATE_HIDDEN = new Set([
  'AB', 'BC', 'BF', 'BS', 'EL', 'ELE', 'ET', 'FL', 'FT', 'GF', 'GG', 'HG', 'IF', 'NS', 'SH', 'SN', 'TG', 'XAV', 'XEU', 'XFA', 'XNB',
  'AC', 'AH', 'AM', 'AN', 'AV', 'AW', 'AX', 'CAC', 'CAF', 'CAH', 'CAM', 'CAN', 'CAV', 'CAW', 'CAX', 'CEU', 'CEV', 'CFA', 'CFU',
  'CGG', 'CIF', 'CNK', 'CNN', 'CNR', 'CNU', 'COS', 'CSH', 'CST', 'CTG', 'EU', 'EV', 'FA', 'FB', 'FU', 'FX', 'KG', 'NB', 'NN',
  'NR', 'NV', 'NZ', 'OB', 'OS', 'OV', 'OW', 'OX', 'PF', 'WD', 'ZVE', '2055', '2065',
]);

/**
 * Whether the tracking page shows the delivery estimate, given the summary
 * code and the newest scan's reason: only while the item is accepted, in
 * distribution or out for delivery, and not after one of those reasons or a
 * missed delivery.
 */
export function austrianPostShowsEstimate(summary: string, newestReason: string): boolean {
  if (summary !== 'AN' && summary !== 'IV' && summary !== 'IZ') return false;
  if (summary === 'IZ' && (newestReason === 'BH' || newestReason === 'BN')) return false;
  return !ESTIMATE_HIDDEN.has(newestReason);
}

export function austrianPostEventStatus(code: string, reason: string, text: string): ClassifiedStatus | undefined {
  if (reason === 'ZA' || /\b(?:wurde zugestellt|successfully delivered)\b/i.test(text)) return SUMMARY.ZU;
  if (['BH', 'BN', 'HB', 'NZ', '2055', '2065'].includes(reason)) return { status: 'exception', stage: 'failed_attempt' };
  if (['EAW', 'HO', 'UPB', '2034'].includes(reason)) return SUMMARY.EB;
  if (/\b(?:rücksendung|zurückgesandt|return to sender)\b/i.test(text)) return SUMMARY.RE;
  if (code === 'AZT' || /\b(?:in zustellung|out for delivery)\b/i.test(text)) return SUMMARY.IZ;
  if (code === 'BEI' || code === 'PUG') return SUMMARY.IV;
  // Unmapped scan codes retain their wording for the host's classifier.
  return SUMMARY[code];
}
