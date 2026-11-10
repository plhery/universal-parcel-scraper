import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SPX's tracking codes, as the Brazilian tracker's reply gives them. Only codes
 * seen in replies are mapped; another code falls to the wording rules. The
 * seller's pickup attempts leave the parcel registered with the seller, and
 * export clearance and the arrival in Brazil are transit milestones.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['A000', 'registered'], // Shopee created the tracking number.
  ['F000', 'registered'], // The seller is preparing the parcel.
  ['F001', 'registered'], // A pickup at the seller that collected nothing.
  ['F004', 'registered'], // A driver is assigned to the pickup.
  ['F096', 'accepted'], // "[China] Pedido enviado": the seller in China sent the parcel on to Shopee's sorting centre.
  ['F098', 'accepted'], // Posted by the seller at a drop-off point in Brazil.
  ['F099', 'accepted'], // Collected from a seller abroad.
  ['F100', 'accepted'], // Collected from a seller in Brazil.
  ['F200', 'in_transit'], ['F202', 'in_transit'], ['F206', 'in_transit'], ['F207', 'in_transit'], ['F210', 'in_transit'],
  ['F219', 'in_transit'], ['F230', 'in_transit'], ['F239', 'in_transit'], ['F299', 'in_transit'], // Transit warehouse abroad.
  ['F300', 'in_transit'], ['F302', 'in_transit'], // With the forwarder that flies the parcel to Brazil.
  ['F339', 'in_transit'], // Export clearance at origin.
  ['F341', 'in_transit'], ['F350', 'in_transit'], ['F355', 'in_transit'], ['F360', 'in_transit'], // Flights and ports.
  ['F366', 'customs'], ['F370', 'customs'], ['F380', 'customs'], // Received, processed and inspected by Brazilian customs.
  ['F399', 'in_transit'], // Released by customs.
  ['F410', 'in_transit'], // Received at the import dispatch warehouse.
  ['F419', 'in_transit'], // Sent on from customs to the last leg in Brazil, before the last-mile hub.
  ['F440', 'in_transit'], ['F441', 'in_transit'], ['F450', 'in_transit'], // First-mile hub.
  ['F510', 'in_transit'], ['F515', 'in_transit'], ['F540', 'in_transit'], ['F541', 'in_transit'], // Sorting centre.
  ['F550', 'in_transit'], ['F580', 'in_transit'], ['A103', 'in_transit'], // Line haul and progress notices.
  ['F596', 'in_transit'], ['F599', 'in_transit'], // Last-mile hub.
  ['F600', 'out_for_delivery'],
  ['F650', 'failed_attempt'], // The day's delivery could not be completed; the route is replanned for another attempt.
  ['A106', 'failed_attempt'], // The notice F650's round can give instead: an unforeseen event, another attempt to follow.
  ['F671', 'returned'], ['F672', 'returned'], ['F674', 'returned'], ['F677', 'returned'], ['F680', 'returned'], // On the way back.
  ['F969', 'exception'], // "Pedido extraviado": the parcel is lost and the buyer refunded.
  ['F979', 'exception'], // Customs refused the import; the parcel goes back or is seized.
  ['F996', 'exception'], // "Pedido descartado": the parcel was disposed of, not delivered or sent back.
  ['F980', 'delivered'],
  ['F999', 'returned'], // Back with the seller.
]);

/**
 * The statuses of SPX's fleet feed, which the tracker reads for a number its order lookup
 * does not hold. Each reads like the order code a live parcel paired it with; the line haul
 * unloading at a hub has no order code of its own and is a transit scan.
 */
const FLEET: ReadonlyMap<string, Stage> = new Map(([
  ['Created', 'registered'], // A000 and F000.
  ['DOP_Received', 'accepted'], // Posted at a drop-off point, as F098.
  ['FMHub_Pickup_Onhold', 'accepted'], // The pickup at the drop-off point waits; the parcel is still there.
  ['FMHub_Pickup_Done', 'accepted'], // F100.
  ['SOC_Pickup_Done', 'accepted'], // The same pickup at the drop-off point, for a sorting centre.
  ['FMHub_Received', 'in_transit'], ['FMHub_LHTransporting', 'in_transit'], // F440 and F450.
  ['SOC_LHUnloading', 'in_transit'], ['SOC_LHUnloaded', 'in_transit'], // F580.
  ['SOC_Received', 'in_transit'], ['SOC_LHTransporting', 'in_transit'], // F510 and F540.
  ['LMHub_LHUnloading', 'in_transit'], ['LMHub_LHUnloaded', 'in_transit'], ['LMHub_Received', 'in_transit'], // F599.
  // The same unloading at a delivery point (an XPT) the delivery leaves from, without its received scan.
  ['Hub_LHUnloading', 'in_transit'], ['Hub_LHUnloaded', 'in_transit'],
  ['Delivering', 'out_for_delivery'], // F600.
  ['Delivered', 'delivered'], // F980.
  ['3PL_Delivered', 'delivered'], // Delivered by the partner carrier SPX handed the parcel to after its sorting centre.
  ['Start_Confiscation', 'exception'], // The parcel entered confiscation: it is held, not delivered.
] as const).map(([status, stage]) => [status.toUpperCase(), stage]));

/** The stage SPX's order code or fleet status gives a scan. */
export function spxBrMappedStage(code: string): Stage | undefined {
  const key = code.toUpperCase();
  return CODES.get(key) ?? FLEET.get(key);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function spxBrStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = spxBrMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? spxBrMappedStage(code) : undefined),
  gaps: [],
};
