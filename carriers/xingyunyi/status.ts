import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * XingYunYi's statuses for a shipment, by the code its page shows them under:
 * Pickup reads 到达待取 (arrived, waiting to be collected) and UnDelivered
 * 未妥投 (not delivered) in Chinese.
 */
const SHIPMENT: ReadonlyMap<string, Stage> = new Map([
  ['InfoReceived', 'registered'],
  ['Transit', 'in_transit'],
  ['Pickup', 'ready_for_pickup'],
  ['Delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['Failed', 'failed_attempt'],
  ['UnDelivered', 'failed_attempt'],
  ['Exception', 'exception'],
]);

/**
 * Scan wordings, without the place the row starts with and its full stop. The
 * scan codes are not shown on the page and cover several kinds of scan, so the
 * wording decides.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['shipment information received', 'registered'],
  // XingYunYi's warehouse in Guangzhou takes the parcel in: its order dates its receipt with this scan.
  ['item inbound in sorting center', 'accepted'],
  ['item outbound in sorting center', 'in_transit'],
  ['arrived export airport', 'in_transit'],
  ['item is ready for departure', 'in_transit'],
  ['item is being presented to customs', 'customs'],
  ['item was released from customs', 'in_transit'],
]);

/** The stage XingYunYi's map gives a shipment status code, or a scan's wording in `normalizeStatusWording` form. */
export function xingyunyiMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? SHIPMENT.get(code) : undefined) ?? WORDINGS.get(wording.replace(/\.$/, ''));
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function xingyunyiStage(wording: string): ClassifiedWording | null {
  const mapped = xingyunyiMappedStage(null, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code and wording seen or named is mapped, except the two answers that hold no scan. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => xingyunyiMappedStage(code, wording),
  gaps: [
    { code: 'NotFound', note: 'The page’s status for a number it has no result for; it stages nothing.' },
    { code: '8', wording: 'not found', note: 'The line’s tracker no longer finds the line’s number. The row is dated when the page asks, so it is not a scan.' },
  ],
};
