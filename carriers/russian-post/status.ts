import { statusWordings } from '../../core/status/english.js';
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The place of a scan: a city the feed gives as a number alone, such as a sorting centre's "63", names none. */
export const russianPostCity = (city: string): string => (/\p{L}/u.test(city) ? city : '');

/** A location stored with such a city, read again without it: "63, Russia" is "Russia". */
export const russianPostPlace = (location: string): string => location.replace(/^[^\p{L},]*\d[^\p{L},]*,\s*(?=\S)/u, '');

const CODES: ReadonlyMap<string, Stage> = new Map([
  ['28.0', 'registered'],
  ['8.0', 'in_transit'], ['8.1', 'in_transit'], ['8.2', 'ready_for_pickup'], ['8.3', 'in_transit'],
  ['8.4', 'in_transit'], ['8.18', 'out_for_delivery'], ['8.20', 'in_transit'], ['4.5', 'exception'],
  // Processing under an attribute the operation list does not name, which the page labels "Sorting" as it does 8.0:
  // written before the item's acceptance (1.1), so read with it rather than as transit the acceptance would undo.
  ['8.83', 'accepted'],
  // International exchange, by the operation list of the open-source lapaygroup/RussianPost client: the
  // exchange office where customs clears the item, transit, arrival in Russia, import and export, customs,
  // and the hand-over to the carrier abroad and the destination's post. Import without an attribute (9.0) is
  // the destination's office of exchange receiving an item Russian Post sent abroad.
  ['8.5', 'customs'], ['8.6', 'in_transit'], ['8.7', 'in_transit'], ['8.8', 'in_transit'], ['8.13', 'in_transit'],
  ['9.0', 'in_transit'], ['9.1', 'in_transit'], ['9.2', 'in_transit'], ['10.0', 'in_transit'], ['11.0', 'customs'], ['14.1', 'in_transit'],
  ['33.1', 'in_transit'], ['33.2', 'in_transit'], ['33.3', 'in_transit'],
]);
const DELIVERY = new Set(['2.6', '2.25']);

/**
 * An operation of type 1 is the acceptance ("Прием"), whatever its attribute: single, batch, simplified
 * prepaid (1.8) or on a forwarder's order, by the lapaygroup/RussianPost operation list.
 */
const codeStage = (code: string): Stage | undefined =>
  code.startsWith('3.') ? 'exception' : code.startsWith('1.') ? 'accepted' : CODES.get(code);

/** A return operation starts the return leg; a later delivery completes that leg. */
export function russianPostStage(code: string, wording: string, returnLeg = false): ClassifiedWording | null {
  if (DELIVERY.has(code)) return { stage: returnLeg ? 'returned' : 'delivered', source: 'carrier_map' };
  const stage = codeStage(code);
  if (stage) return { stage, source: 'carrier_map' };
  const staged = classifyWording(wording, 'in_transit');
  return staged.source === 'none' ? null : staged;
}

export const statusMap: CarrierStatusMap = {
  stage: code => codeStage(code ?? ''),
  gaps: [...DELIVERY].map(code => ({ code, note: 'Delivery completes the forward or return leg; the adapter reads it with the preceding return operation.' })),
};

// The English feed gives some acceptance attributes' labels in Russian. Their entries give the English shown instead.
const WORDINGS = statusWordings(statuses.entries);

/** The English shown for a label the English feed gives in Russian, or undefined. */
export const russianPostEnglish = (wording: string): string | undefined => WORDINGS.english(normalizeStatusWording(wording));
