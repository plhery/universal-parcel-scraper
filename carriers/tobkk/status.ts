import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const PLACEHOLDER = /\\\{station\\\}/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Thai Bear's timeline groups its scans under a Chinese label, and each scan is a Chinese
 * wording that names the warehouse or courier in brackets. The wordings recorded in
 * `statuses.json` carry the stage, `{station}` standing for the bracketed name.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = statuses.entries.map((entry) => [
  new RegExp(`^${escape(normalizeStatusWording(entry.wording)).replace(PLACEHOLDER, '[^【】]{1,40}')}$`, 'u'),
  entry.stage as Stage,
]);

/**
 * The labels whose scans share one stage. 已完成 (done) covers both the hand-over to the Thai
 * courier and the delivery, so it has no stage of its own.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map(statuses.entries.filter((entry) => entry.code !== '已完成')
  .map((entry) => [entry.code, entry.stage as Stage]));

function mapped(code: string | null, wording: string): Stage | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1] ?? (code ? LABELS.get(code) : undefined);
}

/** A scan's stage by its wording or label in the map, else by the shared wording rules, or none. */
export function tobkkStage(label: string | null, description: string): ClassifiedWording | null {
  const stage = mapped(label, normalizeStatusWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [{
    code: '已完成',
    note: 'Thai Bear files both the hand-over to the Thai courier and the delivery under 已完成 (done), so the label alone gives no stage; the scan\'s wording does.',
  }],
};
