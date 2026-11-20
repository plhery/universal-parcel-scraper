import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The tracking page's bill status codes (`billstatus`). Only the code seen in replies is mapped. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['FBC', 'delivered'], // "Đã giao hàng".
]);

/**
 * The bill statuses the developer documentation lists, which the page's
 * `billstatus_desc` words the same way, whole.
 */
const BILL_WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['chưa thành công', 'registered'],
  ['chờ lấy hàng', 'registered'],
  ['vận đơn nháp', 'registered'],
  // A failed pickup leaves the parcel with its sender.
  ['lỗi lấy hàng', 'registered'],
  ['đã lấy hàng', 'accepted'],
  ['da lay hang', 'accepted'],
  ['đang vận chuyển', 'in_transit'],
  ['đang giao hàng', 'out_for_delivery'],
  ['đã giao hàng', 'delivered'],
  ['không phát được', 'failed_attempt'],
  ['sự cố giao hàng', 'exception'],
  ['hủy', 'exception'],
  ['đang chuyển hoàn', 'exception'],
  ['đã chuyển hoàn', 'returned'],
  ['đang giao hàng hoàn', 'exception'],
]);

/**
 * The history's operations, by how they start: a sender, a warehouse or a
 * receiver follows. Longer prefixes come first.
 */
const OPERATIONS: readonly (readonly [string, Stage])[] = [
  ['nhận vận đơn từ', 'accepted'],
  ['nhập vận đơn vào', 'in_transit'],
  ['xuất vận đơn từ', 'in_transit'],
  ['nhập kho:', 'in_transit'],
  ['xuất kho - kho:', 'in_transit'],
  // Out of the last warehouse to the receiver, before "Trả vận đơn cho".
  ['xuất kho trả hàng', 'out_for_delivery'],
  // Handed to the receiver; the documentation's English reads "Delivered to".
  ['trả vận đơn cho', 'delivered'],
  ['bill import to', 'in_transit'],
  ['bill export from', 'in_transit'],
];

/** Whether an operation starts with `prefix` as a whole phrase. */
function startsWithPhrase(text: string, prefix: string): boolean {
  const after = text.slice(prefix.length);
  return text.startsWith(prefix) && (!after || prefix.endsWith(':') || /^[\s:]/.test(after));
}

/** The stage Nhat Tin Logistics' own vocabulary gives a bill status or an operation, in `normalizeStatusWording` form. */
export function nhatTinMappedStage(code: string | null, wording: string): Stage | undefined {
  const text = wording.normalize('NFC');
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? BILL_WORDINGS.get(text)
    ?? OPERATIONS.find(([prefix]) => startsWithPhrase(text, prefix))?.[1];
}

/** A history operation's stage: the map, else the shared wording rules, else nothing. */
export function nhatTinStage(wording: string): ClassifiedWording | null {
  if (!wording) return null;
  const mapped = nhatTinMappedStage(null, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The bill's own status: its code, else its wording. */
export function nhatTinBillStage(code: string, wording: string): Stage | undefined {
  return nhatTinMappedStage(code || null, normalizeStatusWording(wording));
}

/** Every code and wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => nhatTinMappedStage(code, wording),
  gaps: [],
};
