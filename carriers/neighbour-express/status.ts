import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const CODES = new Map(statuses.entries.map(row => [row.code, row.stage as Stage]));
const WORDINGS = new Map(statuses.entries.map(row => [normalizeStatusWording(row.wording), row.stage as Stage]));
export const neighbourStage = (code: string | null, wording: string): Stage | undefined =>
  (code === null ? undefined : CODES.get(code)) ?? WORDINGS.get(normalizeStatusWording(wording));
export const statusMap: CarrierStatusMap = { stage: neighbourStage, gaps: [] };
