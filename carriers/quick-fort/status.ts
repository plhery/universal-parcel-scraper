import { statusWordings } from '../../core/status/english.js';
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

// The rows that name a city, an airport or a country: "… d'origine à Toronto.", "… de l'aéroport international Pearson
// de Toronto.", "… à l'aéroport in DE.", and in English "… processing facility Toronto.", "… completed [Toronto].",
// "Shipment arrived at DE Airport", "… at the DE destination processing facility.".
const PLACES = [
  /^(le colis est arrivé au centre de traitement d'origine à ).+?(\.?)$/,
  /^(l'envoi est arrivé au terminal de fret de l'aéroport ).+?(\.?)$/,
  /^(l'envoi a quitté l'aéroport ).+?( et est en transport international\.?)$/,
  /^(l'envoi est arrivé à l'aéroport ).+?(\.?)$/,
  /^(parcel received at the processing facility ).+?(\.?)$/,
  /^(parcel sorted and ready for international dispatch ).+?(\.?)$/,
  /^(parcel departed the processing facility ).+?(\.?)$/,
  /^(origin processing completed \[).+?(\]\.?)$/,
  /^(shipment arrived at ).+?( airport\.?)$/,
  /^(shipment arrived at the ).+?( destination processing facility\.?)$/,
];

// The places the parser takes out of the English rows, a postcode or a street with them, as wordings observed
// before it did still carry them: "… local warehouse in <region>,<country>,<postcode>,<town>.", "Out for delivery in
// <town>,<postcode>,<country>", "… delivery station, serving <town>,<postcode>.", "Delivered <street> <number>".
const WITHIN = [
  /^(consignment received at the local warehouse) in [^.]+(\.?)$/,
  /^(out for delivery) in [^.]+(\.?)$/,
  /^(parcel arrived at the local delivery station), serving [^.]+(\.?)$/,
  /^(delivered) (?=.*\d).+?(\.?)$/,
];

/**
 * The key a row's `normalizeStatusWording` wording is mapped under: a city, airport or country it names becomes an
 * ellipsis, a place the parser takes out goes, and a doubled final full stop is one.
 */
export const quickFortScanKey = (wording: string): string => {
  const key = wording.replace(/\.(?:\s*\.)+$/, '.');
  const within = WITHIN.find((pattern) => pattern.test(key));
  if (within) return key.replace(within, '$1$2');
  const place = PLACES.find((pattern) => pattern.test(key));
  return place ? key.replace(place, '$1…$2') : key;
};

/** The stage Quick Fort's map gives a row's `normalizeStatusWording` wording. */
const mappedStage = (wording: string): Stage | undefined => WORDINGS.stage(quickFortScanKey(wording));

/**
 * Quick Fort's rows have no codes: its map reads the carrying network's French and English sentences, then the shared
 * classifier reads any other, without a fallback stage.
 */
export function quickFortStage(wording: string): ClassifiedWording | null {
  if (!wording) return null;
  const mapped = mappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const staged = classifyWording(wording, 'in_transit');
  return staged.source === 'none' ? null : staged;
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => mappedStage(wording), gaps: [] };
