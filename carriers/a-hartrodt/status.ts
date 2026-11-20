import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const wordings: ReadonlyMap<string, Stage> = new Map([
  ['exp - consignment registered/initiated', 'registered'],
  ['exp - consignment in port - docs complete', 'in_transit'],
  ['exp - consignment definitely loaded', 'in_transit'],
  ['exp - shipped on board', 'in_transit'],
  ['exp - flight/vessel departed (atd)', 'in_transit'],
  ['imp - flight/vessel arrived', 'in_transit'],
]);

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage(_code, wording) {
    return wordings.get(wording);
  },
  gaps: [{ wording: 'imp - information', note: 'An information notice with no movement or delivery stated.' }],
  gapNote(code, wording) {
    if (!code && /^imp - shipment schedule changed- new arrival date \(eta\):/.test(wording)) {
      return 'A revision of the planned vessel or flight arrival.';
    }
    return undefined;
  },
};
