import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

interface PostOneStatus {
  code: string;
  wording: string;
  stage: Stage;
  icon: string;
}

// The untranslated keys and archived English rows share these distinct tracker icons.
const STATUSES: readonly PostOneStatus[] = [
  { code: 'crd', wording: 'Created', stage: 'registered', icon: 'created.png' },
  { code: 'apo', wording: 'Sorted at Hub', stage: 'in_transit', icon: 'accepted.png' },
  { code: 'ded', wording: 'Departed to Destination', stage: 'in_transit', icon: 'transit.png' },
  { code: 'icn', wording: "In Carrier's Network", stage: 'in_transit', icon: 'network.png' },
  { code: 'ofd', wording: 'Out for Delivery', stage: 'out_for_delivery', icon: 'outfordelivery.png' },
  { code: 'dld', wording: 'Delivered', stage: 'delivered', icon: 'delivered.png' },
];

const normalized = (value: string): string => value.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();

/** Only the official keys and complete verified labels, never recipient prose. */
export function postOneStatus(wording: string): PostOneStatus | undefined {
  const text = normalized(wording);
  return STATUSES.find(status => text === 'main_status.' + status.code || text === normalized(status.wording));
}

export function postOneStage(code: string | null, wording: string): Stage | undefined {
  if (code) return STATUSES.find(status => status.code === normalized(code).replace(/^main_status\./, ''))?.stage;
  return postOneStatus(wording)?.stage;
}

export const statusMap: CarrierStatusMap = { stage: postOneStage, gaps: [] };
