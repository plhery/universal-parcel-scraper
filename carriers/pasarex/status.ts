import { statusWordings } from '../../core/status/english.js';
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

/** The stage PasarEX's map gives a row's `normalizeStatusWording` wording. */
const mappedStage = (wording: string): Stage | undefined => WORDINGS.stage(wording);

/**
 * PasarEX's rows have no codes: its map reads each sentence whole, then the shared classifier reads any other,
 * without a fallback stage. The status a row is grouped under is broader than its sentence and decides nothing.
 */
export function pasarexStage(wording: string): ClassifiedWording | null {
  if (!wording || WORDINGS.unstaged(normalizeStatusWording(wording))) return null;
  const mapped = mappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const staged = classifyWording(wording, 'in_transit');
  return staged.source === 'none' ? null : staged;
}

// Its rows that move nothing, such as an arrangement with the recipient during the round, by their catalog notes.
const GAPS = statuses.entries.filter((entry) => entry.stage === null)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? 'A row that moves nothing.' }));

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => mappedStage(wording), gaps: GAPS };
