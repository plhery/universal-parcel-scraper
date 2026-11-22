import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker names each activity by a three-letter Cargo-IMP code; the wording is its own English translation.
const ENTRIES: ReadonlyMap<string, { wording: string; stage: Stage | null }> = new Map(statuses.entries
  .map((entry) => [entry.code, { wording: entry.wording, stage: entry.stage as Stage | null }]));

export const activityStage = (code: string): Stage | undefined => ENTRIES.get(code)?.stage ?? undefined;
export const activityWording = (code: string): string | undefined => ENTRIES.get(code)?.wording;

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? activityStage(code) : undefined),
  gaps: statuses.entries.filter((entry) => entry.stage === null).map((entry) => ({ code: entry.code, note: entry.note ?? '' })),
};
