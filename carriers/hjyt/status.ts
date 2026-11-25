import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

// iMile's rows name its centre or station in brackets: "Delivery,Your order has arrived at 【AUH DS】". The name becomes an ellipsis.
const PLACE = /【[^】]*】/g;

/**
 * The stage Hengjie Yutong's map gives a row, by its `normalizeStatusWording` wording. The
 * warehouse's receipt (`ARRIVAL`) and departure (`SHIPMENT`) have wordings of their own, so a kind
 * code decides nothing.
 */
export function hjytStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording.replace(PLACE, '【…】'));
}

export const statusMap: CarrierStatusMap = { stage: hjytStage, gaps: [] };
