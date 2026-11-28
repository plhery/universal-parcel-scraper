import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap, type IntentionalStatusGap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * One entry of a `statuses.json` on the package logs platform (`packageLogs.ts`): a log's
 * wording, without a code, or a package's `status_string` or alert (`alert:<n>`) by its code.
 */
export interface PackageLogsEntry {
  readonly code?: string | null;
  readonly wording?: string | null;
  readonly stage?: string | null;
  readonly note?: string | null;
}

export interface PackageLogsStatus {
  /** A log's stage: its wording as the company words it, else the shared wording rules. */
  readonly logStage: (wording: string) => ClassifiedWording | null;
  /** The stage of a package's `status_string`, or of its alert as `alert:<n>`. */
  readonly codeStage: (code: string) => Stage | undefined;
  readonly statusMap: CarrierStatusMap;
}

/** A company's map on the platform, from its `statuses.json`: a code entry without a stage is a gap. */
export function packageLogsStatus(entries: readonly PackageLogsEntry[]): PackageLogsStatus {
  const wordings = new Map<string, Stage>();
  const codes = new Map<string, Stage>();
  const gaps: IntentionalStatusGap[] = [];
  for (const { code, wording, stage, note } of entries) {
    if (code && stage) codes.set(code, stage as Stage);
    else if (code) gaps.push({ code, note: note ?? '' });
    else if (wording && stage) wordings.set(normalizeStatusWording(wording), stage as Stage);
  }
  return {
    logStage: (wording) => {
      const stage = wordings.get(normalizeStatusWording(wording));
      if (stage) return { stage, source: 'carrier_map' };
      const worded = classifyWording(wording, 'in_transit');
      return worded.source === 'none' ? null : worded;
    },
    codeStage: (code) => codes.get(code),
    statusMap: {
      stage: (code, wording) => wordings.get(normalizeStatusWording(wording)) ?? (code ? codes.get(code) : undefined),
      gaps,
      wholeWording: true,
    },
  };
}

export const theHumanStatus = packageLogsStatus(statuses.entries);
export const statusMap: CarrierStatusMap = theHumanStatus.statusMap;
