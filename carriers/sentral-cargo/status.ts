import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** The row's badge and the receipt's, which the scan's wording outranks. */
export const BADGES = new Map<string, Stage>([['delivered', 'delivered'], ['on process', 'in_transit']]);
const STATUS_PREFIXES: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^Paket dipickup oleh kantor\b/i, 'accepted'],
  [/^Paket sedang dikirimkan ke\b/i, 'out_for_delivery'],
  [/^Antar sebagian\b/i, 'in_transit'],
  [/^Paket (?:sudah diterima oleh kantor|dikirim dari)\b/i, 'in_transit'],
];

/** The stage a scan's wording gives it. */
export function sentralStage(description: string): Stage | undefined {
  return STATUS_PREFIXES.find(([pattern]) => pattern.test(description))?.[1];
}

/** The map reads a scan's wording. A row's badge, which a scan does not keep, stages the rest. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => sentralStage(wording),
  gaps: [],
};
