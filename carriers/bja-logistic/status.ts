import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage | null]));

export function bjaStage(wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording)) ?? undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => bjaStage(wording),
  wholeWording: true,
  gaps: [
    { wording: 'barang diterima', note: 'The goods were received, but the scan gives no recipient or facility.' },
    { wording: 'menunggu jadwal keberangkatan kapal', note: 'The goods are waiting for a ship schedule and this scan does not confirm movement.' },
  ],
};
