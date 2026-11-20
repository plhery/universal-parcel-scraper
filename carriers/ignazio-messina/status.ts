import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['IS:Delivered', 'delivered'],
  ['SBP:Discharged', 'in_transit'],
  ['SBP:Transhipment Discharge', 'in_transit'],
  ['IBP:Transhipment Load', 'in_transit'],
  ['IBP:Loaded', 'in_transit'],
  ['RP:Gate In Full', 'in_transit'],
]);

export function scanStage(code: string, description: string): Stage | undefined {
  return stages.get(`${code}:${description}`);
}
