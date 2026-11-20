import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Swire's page names each move of a container, with no code: a gate move with its load, such as
 * "Gate In Full", or a vessel move, such as "Import Discharged from Vessel".
 */
const STAGES: Readonly<Record<string, Stage>> = {
  // The shipper takes an empty container to load and brings it back full.
  'gate out empty': 'registered',
  'gate in full': 'accepted',
  'export loaded on vessel': 'in_transit',
  'vessel departure': 'in_transit',
  'vessel arrival': 'in_transit',
  'transhipment discharged from vessel': 'in_transit',
  'transhipment loaded on vessel': 'in_transit',
  'import discharged from vessel': 'in_transit',
  // The consignee takes the container full and returns it empty.
  'gate out full': 'out_for_delivery',
  'gate in empty': 'delivered',
};

/** The stage a move's wording gives on its own; the container's other moves can change it. */
export function swireStage(wording: string): Stage | undefined {
  return STAGES[normalizeStatusWording(wording)];
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => swireStage(wording),
  gaps: [],
};
