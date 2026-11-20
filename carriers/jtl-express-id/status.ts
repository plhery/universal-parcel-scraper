import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The tracker gives no codes: its rows are sentences with the branch, the town or the courier in
// them, so each is known by how it starts, once the courier's or recipient's name is gone.
const WORDING: readonly (readonly [RegExp, Stage])[] = [
  // The shop asked for a pickup.
  [/^terima permintaan pick ?up\b/, 'registered'],
  // A branch took the parcel in, or a courier picked it up.
  [/^barang di ?terima di pos\b/, 'accepted'],
  [/^paket telah di ?pick ?up\b/, 'accepted'],
  // Sent back to a branch and held there until the customer confirms.
  [/^paket di ?kembalikan di\b.*\(hold\) menunggu konfirmasi pelanggan$/, 'exception'],
];

/** The stage of a row's wording; undefined for wording the map does not know. */
export function jtlExpressStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  return WORDING.find(([pattern]) => pattern.test(text))?.[1];
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => jtlExpressStage(wording),
  gaps: [],
};
