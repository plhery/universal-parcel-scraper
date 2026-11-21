import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * TP Logistics' history page words each scan in Thai, and its search page
 * gives one summary status in English. The codes archived pages printed in
 * brackets before a wording follow it, so the map reads the wording alone. A
 * hold reason keeps its number, as the page prints it.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // Goods checked and the consignment note keyed in, or recorded and paid for, at the origin branch.
  ['ตรวจสอบสินค้าและคีย์เอกสาร', 'accepted'],
  ['บันทึกเอกสารและชำระเงิน', 'accepted'],
  // Taken into a branch's warehouse to wait for dispatch, at each branch on the way and at the last.
  ['รับสินค้าเข้าคลังรอจัดส่ง', 'in_transit'],
  ['ดำเนินการส่งสินค้าไปที่ศูนย์กระจายสินค้า', 'in_transit'],
  ['รับสินค้าเข้าคลังศูนย์กระจายสินค้า', 'in_transit'],
  // On its way to the recipient: not yet delivered.
  ['ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง', 'out_for_delivery'],
  ['ส่งสินค้าถึงปลายทางเรียบร้อย', 'delivered'],
  // Not delivered and taken back into the branch's warehouse for another round.
  ['จัดส่งไม่ได้/รับสินค้ากลับคืนคลัง', 'failed_attempt'],
  // Held at the branch; the hold reason beside it says why.
  ['พักสินค้า', 'exception'],
  // Hold reason 3: the recipient asked to take the parcel on a later day.
  ['3.ผู้รับขอเลื่อนวันรับสินค้า (ถ่ายรูปวันเลื่อนรับ)', 'failed_attempt'],
  // The search page's summary status.
  ['Delivered', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's or the summary's wording. */
export function tpWordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A wording's stage: TP Logistics' own wording, else the shared wording rules, else nothing. */
export function tpStage(wording: string): ClassifiedWording | null {
  const mapped = tpWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one status, by its wording: the codes old pages printed name the same steps. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => tpWordingStage(wording),
  gaps: [],
};
