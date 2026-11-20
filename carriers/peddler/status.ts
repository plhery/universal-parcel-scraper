import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The tracker's event codes seen on its public replies: the order, the first scan at the
// distribution centre, the trips to and arrivals at a local depot, the round, the delivery and a
// failed attempt.
const CODES = new Map<string, Stage>([
  ['100', 'registered'], ['210', 'accepted'], ['300', 'in_transit'], ['310', 'in_transit'],
  ['405', 'out_for_delivery'], ['502', 'delivered'], ['603', 'failed_attempt'],
]);
// Their English and Dutch headlines. A new attempt being planned or new delivery details are
// notices, not movements.
const WORDINGS = new Map<string, Stage>(([
  ['Shipment confirmed', 'registered'], ['Verzending bevestigd', 'registered'],
  ['Package at distribution center', 'accepted'], ['Pakket bij distributiecentrum', 'accepted'],
  ['Enroute to local depot', 'in_transit'], ['Onderweg naar depot', 'in_transit'],
  ['Package in local depot', 'in_transit'], ['Pakket in lokaal depot', 'in_transit'],
  ['Out for delivery', 'out_for_delivery'], ['Onderweg naar afleveradres', 'out_for_delivery'],
  ['Delivery attempt failed', 'failed_attempt'], ['Afleverpoging mislukt', 'failed_attempt'],
  ['Delivered', 'delivered'], ['Bezorgd', 'delivered'], ['Afgelevered', 'delivered'],
  // Description lines the page shows under some headlines, and a failed attempt's reason.
  ['Shipment registered by client with Peddler', 'registered'], ['Verzending aangemeld door klant bij Peddler', 'registered'],
  ['Package enroute to destination', 'out_for_delivery'], ['Customer not home; no neighbours available', 'failed_attempt'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const NOTICES = new Set(['Planning your next delivery attempt now.', 'Delivery schedule updated', 'Delivery address updated']
  .map(normalizeStatusWording));

/** The stage of one event by its code, else by its headline; a notice has none. */
export function peddlerStage(code: string, headline: string): ClassifiedWording | null {
  const wording = normalizeStatusWording(headline);
  const stage = CODES.get(code) ?? WORDINGS.get(wording);
  if (stage) return { stage, source: 'carrier_map' };
  if (NOTICES.has(wording)) return null;
  const classified = classifyWording(headline, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : undefined) ?? WORDINGS.get(wording),
  gaps: [],
};
