import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Azerpost's scan wordings, mapped whole. The tracker names a scan by its UPU event, in the
 * language the lookup asks for: the adapter asks for English, and Azerpost's former tracker
 * showed the Azerbaijani names. The replies carry no event code, so the wording sets the stage.
 */
export const AZERPOST_EVENTS: Readonly<Record<string, Stage>> = {
  'Posting/collection': 'accepted',
  'Arrival at outward office of exchange': 'in_transit',
  'Departure from outward office of exchange': 'in_transit',
  'Qəbul olunub': 'accepted',
  'Mübadilə məntəqəsinə daxil olub': 'in_transit',
  'Göndərən ölkənin mübadilə məntəqəsinə daxil olub': 'in_transit',
  'Göndərən ölkənin mübadilə məntəqəsindən yola salınıb': 'in_transit',
  'Təyinat ölkəsinin mübadilə məntəqəsinə daxil olub': 'in_transit',
  'Çatdırma məntəqəsinə daxil olub': 'in_transit',
  'Poçt şöbəsinə daxil olub': 'in_transit',
  // At the office the addressee collects it from.
  'Alıcının özünün gəlib götürməsi üçün təfilvermə məntəqəsinə daxil olub': 'ready_for_pickup',
  'Fiziki çatdırılmaya göndərilib': 'out_for_delivery',
  'Çatdırılıb': 'delivered',
};

const EVENTS = new Map(Object.entries(AZERPOST_EVENTS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording, if it knows it. */
export function azerpostEventStage(wording: string): Stage | undefined {
  return EVENTS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function azerpostStage(wording: string): ClassifiedWording | null {
  const mapped = azerpostEventStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The wording sets the stage; the replies carry no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : azerpostEventStage(wording)),
  gaps: [],
};
