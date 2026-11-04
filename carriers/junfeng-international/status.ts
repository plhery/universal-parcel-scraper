import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function junfengInternationalGap(wording: string): string | undefined {
  return /^头程航班预计\d{1,2}日\d{1,2}:\d{2}起飞$/.test(wording)
    ? 'A planned flight notice is not an actual departure.' : undefined;
}

export function junfengInternationalStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  if (junfengInternationalGap(text)) return undefined;
  if (/\bdelivered to safe place$/.test(text)) return 'delivered';
  if (/\bout for delivery$/.test(text)) return 'out_for_delivery';
  if (/\bshipment received in depot$/.test(text)) return 'in_transit';
  if (text === '航司载量不足，头程延误，航班预配中') return 'exception';
  if (['清关完成，已交邮', '飞机已到达，正在拆板', '飞机已起飞，送往目的地', '航司已收货，等待装板', '已发货，司机正在送到机场'].includes(text)) return 'in_transit';
  return undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => junfengInternationalStage(wording), gaps: [],
  gapNote: (_code, wording) => junfengInternationalGap(wording),
};
