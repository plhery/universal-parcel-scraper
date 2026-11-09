import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^item collected at post office$/, 'accepted'],
  [/^item departed to final destination$/, 'in_transit'],
  [/^item received at sorting center$/, 'in_transit'],
  [/^item handed over to customs for clearance(?: retention reason: .*)?$/, 'customs'],
  [/^item received back from customs$/, 'in_transit'],
  [/^item sent to distribution office$/, 'in_transit'],
  [/^item delivered$/, 'delivered'],
];

export function libanPostWordingStage(wording: string): Stage | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(normalizeStatusWording(wording)))?.[1];
}

export function libanPostStage(wording: string): ClassifiedWording | null {
  const stage = libanPostWordingStage(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : libanPostWordingStage(wording), gaps: [],
};
