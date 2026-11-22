import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The stages of the office scans, by the code the full history gives each. */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.code && entry.stage)
  .map(entry => [entry.code!, entry.stage as Stage]));

// The page's own steps and status lines, each written for a parcel ("Paquete …") or for
// correspondence ("Correspondencia …"); the map reads them without that first word.
const SUBJECT = /^(?:tu )?(?:paquete|correspondencia) /;
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => !entry.code && entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording).replace(SUBJECT, ''), entry.stage as Stage]));
// "Entregado el 30/10/2026, gracias por tu confianza.": the delivered status line, dated.
const DELIVERED_LINE = /^entregado el \d{2}\/\d{2}\/\d{4}, gracias por tu confianza\.$/;

/** The stage of an office scan's code. */
export function correosGuatemalaCodeStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The stage of one of the page's steps or of its status line. */
export function correosGuatemalaWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  if (DELIVERED_LINE.test(normalized)) return 'delivered';
  return WORDINGS.get(normalized.replace(SUBJECT, ''));
}

/** Office scans carry their code; the page's steps carry their wording alone. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : correosGuatemalaWordingStage(wording)),
  gaps: [],
};
