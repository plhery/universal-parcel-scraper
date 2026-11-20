import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['tercatat di gudang asal', 'registered'],
  ['tiba di pelabuhan kota/kab tujuan', 'in_transit'],
]);

export function scanStage(status: string): Stage | undefined {
  return stages.get(status.toLowerCase());
}
