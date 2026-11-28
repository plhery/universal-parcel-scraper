/**
 * Xiong Da's rows carry its system's event codes, with a label in Chinese and in English. A code has one
 * stage whatever its row's note says, but for 9060, an update in words of its own: the firm's notes from the
 * United States, and the scans it copies from UPS, each after a label such as 正在派送 that says little. Such a
 * row's stage comes from its words. A code `statuses.json` does not record goes through the shared wording
 * rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The code of an update in words of its own, which UPS's copied scans also carry. */
export const UPDATE_CODE = '9060';
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.flatMap((entry) => entry.code && entry.code !== UPDATE_CODE && entry.stage
  ? [[entry.code, entry.stage as Stage] as const] : []));
const UPDATES: ReadonlyMap<string, Stage> = new Map(ENTRIES.flatMap((entry) => entry.code === UPDATE_CODE && entry.wording && entry.stage
  ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));
// The label before an update's words, as the page shows the row: 正在派送 Arrived at Facility.
const LABEL = /^\p{Script=Han}+\s+/u;
// An update comes once the cartons have left the warehouse, so its words read as no earlier step.
const EARLY: ReadonlySet<string> = new Set(['pending', 'registered', 'accepted']);

/** An update's words, without the label the row puts before them. */
export function updateWords(description: string): string {
  return description.replace(LABEL, '');
}

/** An update's stage: the map's for words it records, else the shared rules', and the journey going on for anything earlier or unread. */
function updateStage(description: string): ClassifiedWording {
  const words = updateWords(description);
  const recorded = UPDATES.get(normalizeStatusWording(words));
  if (recorded) return { stage: recorded, source: 'carrier_map' };
  const worded = classifyWording(words, 'pending');
  return worded.source === 'none' || EARLY.has(worded.stage) ? { stage: 'in_transit', source: 'carrier_map' } : worded;
}

/** A row's stage by its code and its wording as the page shows it; null when nothing reads it. */
export function xiongdaStage(code: string, description: string): ClassifiedWording | null {
  if (code === UPDATE_CODE) return updateStage(description);
  const mapped = CODES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'pending');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === UPDATE_CODE ? updateStage(wording).stage : code ? CODES.get(code) : undefined),
  gaps: [],
};
