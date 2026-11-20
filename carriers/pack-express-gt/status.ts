import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const milestones = statuses.entries.map(({ code, wording, stage }) => ({ code, wording, stage: stage as Stage }));
const byCode = new Map(milestones.map(({ code, stage }) => [code, stage]));
const byWording = new Map(milestones.map(({ wording, stage }) => [normalizeStatusWording(wording), stage]));

export function packStage(code: string | null, wording: string): Stage | undefined {
  return (code ? byCode.get(code) : undefined) ?? byWording.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: packStage,
  gaps: [
    { wording: 'completo', note: 'The guide badge describes the record, while the route reports delivery separately.' },
    { wording: 'entregado en taller', note: 'The device went to the workshop and has a separate onward shipment.' },
    { wording: 'cerrado', note: 'A closed device service record does not state that the package reached its recipient.' },
  ],
  wholeWording: true,
};
