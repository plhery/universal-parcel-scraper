import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string | null; readonly english?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// A row in Chinese and then the same in English: in brackets, "已交航(Package handed over to airline)",
// or after a slash, a comma or a space, "清关中/Customs clearance in progress".
const BILINGUAL = /^([^a-z]*\p{Script=Han}[^a-z]*?)\s*(?:[(（]([^()（）\p{Script=Han}]*[a-z][^()（）\p{Script=Han}]*)[)）]|[/,，\s]\s*([a-z][^\p{Script=Han}]*))$/iu;

/** The English half of a row in Chinese and then in English. */
function englishHalf(wording: string): string | undefined {
  const match = BILINGUAL.exec(wording.trim());
  return match ? (match[2] ?? match[3])!.trim() : undefined;
}

// The booked flight's day, as month.day and in English: "预计11.7航班（Flight scheduled for November 7th）".
const FLIGHT_DAY = /^(预计)\d{1,2}[./]\d{1,2}(航班[（(]flight scheduled for )[a-z]+\.? ?\d{1,2}(?:st|nd|rd|th)([）)])$/;
const ENGLISH_FLIGHT_DAY = /^(flight scheduled for )[a-z]+\.? ?\d{1,2}(?:st|nd|rd|th)$/;
// The day a delayed flight is put off to: "航班延误至8号飞（The flight has been delayed until the 8th）".
const DELAY_DAY = /^(航班延误至)\d{1,2}(号飞[（(]the flight has been delayed until the )\d{1,2}(?:st|nd|rd|th)([）)])$/;
const ENGLISH_DELAY_DAY = /^(the flight has been delayed until the )\d{1,2}(?:st|nd|rd|th)$/;

/** A wording in `normalizeStatusWording` form, with the days the map reads as ellipses. */
const key = (wording: string): string => wording.replace(FLIGHT_DAY, '$1…$2…$3').replace(ENGLISH_FLIGHT_DAY, '$1…')
  .replace(DELAY_DAY, '$1…$2…$3').replace(ENGLISH_DELAY_DAY, '$1…');

// Each wording, the English an entry gives it and the English half of a row in both languages, which
// the map reads as the whole row. Null for a row listed without a stage.
const STAGES = new Map<string, Stage | null>(ENTRIES.flatMap((entry) => {
  const half = englishHalf(entry.wording);
  return [entry.wording, ...(entry.english ? [entry.english] : []), ...(half ? [half] : [])]
    .map((wording) => [normalizeStatusWording(wording), entry.stage as Stage | null] as const);
}));
const ENGLISH = new Map(ENTRIES.flatMap((entry) => (entry.english ? [[normalizeStatusWording(entry.wording), entry.english] as const] : [])));

function mapped(wording: string): Stage | null | undefined {
  const own = STAGES.get(key(wording));
  if (own !== undefined) return own;
  const half = englishHalf(wording);
  return half === undefined ? undefined : STAGES.get(key(normalizeStatusWording(half)));
}

/**
 * The stage Zhongzhou Logistics' map gives a row, by its `normalizeStatusWording` wording, the
 * English the adapter shows for it or its English half, with a booked flight's day read as an
 * ellipsis. A row's kind code groups wordings and decides nothing.
 */
export function zhongzhouStage(_code: string | null, wording: string): Stage | undefined {
  return mapped(wording) ?? undefined;
}

/**
 * The English the adapter shows for a row: the English half of a row in both languages, or the
 * English of a row the tracker words only in Chinese. `shown` is the row as the tracker writes it.
 */
export function zhongzhouEnglish(_code: string | null, wording: string, shown: string): string | undefined {
  return englishHalf(shown) ?? ENGLISH.get(wording);
}

/** Whether a row is a booked flight or its delay: a notice, no movement. */
export function isZhongzhouNotice(_code: string | null, wording: string): boolean {
  return mapped(wording) === null;
}

/**
 * Whether two rows are one scan in two wordings: the tracker writes some rows in Chinese and again
 * in English at the same clock, "法国海关查验" beside "French Customs inspection".
 */
export function repeatsZhongzhouRow(wording: string, other: string): boolean {
  const shown = (value: string) => {
    const normalized = normalizeStatusWording(value);
    return normalizeStatusWording(zhongzhouEnglish(null, normalized, value) ?? value);
  };
  return normalizeStatusWording(wording) !== normalizeStatusWording(other) && shown(wording) === shown(other);
}

const NOTICE_NOTE = 'The flight booked for the parcel, or its delay: no movement, so the parcel keeps the stage of the scan before it.';

/** A booked flight and its delay have no stage of their own: they keep the one before them. */
export const statusMap: CarrierStatusMap = { stage: zhongzhouStage, gaps: [],
  gapNote: (code, wording) => (isZhongzhouNotice(code, wording) ? NOTICE_NOTE : undefined) };
