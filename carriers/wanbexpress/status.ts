import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: Readonly<Record<string, Stage>> = {
  DataReceived: 'registered', SupplierDataReceived: 'registered', OriginalWarehouseReceive: 'accepted',
  OriginalWarehouseProcess: 'in_transit', OriginalWarehouseDeparture: 'in_transit',
  LinehaulAgencyReceive: 'in_transit', LinehaulAgencyDeparture: 'in_transit', LinehaulDeparture: 'in_transit',
  LinehaulArrival: 'in_transit', CustomsCleared: 'in_transit', SupplierAndLastMileReceive: 'in_transit',
  LastMileInTransit: 'in_transit', LastMileOutForDelivery: 'out_for_delivery', LastMileDelivered: 'delivered',
};

export const statusMap: CarrierStatusMap = {
  stage: code => code && Object.hasOwn(STAGES, code) ? STAGES[code] : undefined, gaps: [],
};
