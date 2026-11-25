/**
 * Wording rules that hold for one carrier only, or for the copies one universal provider relays of
 * that carrier's scans: a word the carrier uses in a sense of its own, which the shared rules leave
 * open, or read otherwise, for everyone else.
 */
import type { Stage } from '../../generated/catalog.js';
import { normalizeStatusWording } from './statusMap.js';

export interface ScopedWordingRule {
  /** The catalog carrier whose scans the rule reads. */
  readonly carrier: string;
  /** The universal providers whose copies of the carrier's scans the rule reads; every source when absent. */
  readonly providers?: readonly string[];
  /** The whole wording, as `normalizeStatusWording` writes it. */
  readonly wording: string;
  readonly stage: Stage;
  /** Why the carrier's word reads so. */
  readonly note: string;
}

export const SCOPED_WORDINGS: readonly ScopedWordingRule[] = [
  {
    carrier: 'buffalo-ex', providers: ['ParcelsApp'], wording: 'returns', stage: 'failed_attempt',
    note: "BUFFALO's parcel back at its depot undelivered after a round, as ParcelsApp relays it: each came the evening after a "
      + "vehicle departure, the parcel left again the next morning, and after four such rounds it went back to the sender. "
      + "Elsewhere the bare word can name a return to the sender.",
  },
  {
    carrier: 'buffalo-ex', providers: ['ParcelsApp'], wording: 'collected', stage: 'in_transit',
    note: "The local courier collecting a BUFFALO parcel from BUFFALO's depot, as ParcelsApp relays it: it came after the "
      + "customs release and the hubs, before the courier's first round. Elsewhere the word is the acceptance from the sender.",
  },
  {
    carrier: 'buffalo-ex', providers: ['ParcelsApp'], wording: 'scan vehicle departure', stage: 'out_for_delivery',
    note: "The local courier's delivery round on a BUFFALO parcel, as ParcelsApp relays it: each departure came early in the "
      + "morning, the parcel was back at the depot that evening, and no round ran on the Sunday. Elsewhere a vehicle can leave for another depot.",
  },
  {
    carrier: 'buffalo-ex', providers: ['ParcelsApp'], wording: 'in trip', stage: 'out_for_delivery',
    note: "The local courier's delivery trip on a BUFFALO parcel, as ParcelsApp relays it: it came after the parcel was scanned "
      + "into the vehicle's cage and before the delivery. Elsewhere a trip can run between depots.",
  },
  {
    carrier: 'poste-italiane', providers: ['Ship24'], wording: 'processing at warehouse', stage: 'in_transit',
    note: "A warehouse's handling of a Poste Italiane parcel, as Ship24 relays it: it came between the warehouse's receipt and "
      + "its departure, which read in transit, as do the same rows Poste's own tracking shows.",
  },
  {
    carrier: 'buffalo-ex', wording: 'international shipping', stage: 'in_transit',
    note: "BUFFALO's own status for a parcel that has left China, as its tracker shows it and providers relay it.",
  },
  {
    carrier: 'buffalo-ex', wording: 'dispatching', stage: 'in_transit',
    note: "BUFFALO's own status at its depot minutes before a driver takes the parcel, as its tracker shows it and providers "
      + "relay it: not the round itself. Elsewhere a seller can be dispatching an order no carrier has.",
  },
  {
    carrier: 'ctt-express', wording: 'almacenado temporalmente', stage: 'exception',
    note: "CTT Express's status 1700, as providers relay its wording without the code: the parcel held at the depot after a "
      + "failed delivery, until a new round or a return, as CTT Express's map reads the code. Elsewhere a parcel can be stored on its way.",
  },
  // PTT's Turkish statuses in a provider's English, as 17TRACK relays them: each as PTT's own map reads the Turkish.
  {
    carrier: 'ptt', wording: 'ptt in the workplace', stage: 'ready_for_pickup',
    note: "PTT's \"PTT İŞYERİNDE\": the item waits at the PTT office the scan names, after a failed delivery.",
  },
  {
    carrier: 'ptt', wording: 'in intrastate transfer', stage: 'in_transit',
    note: "PTT's \"İL İÇİ AKTARMADA\": the item sent on within a province.",
  },
  {
    carrier: 'ptt', wording: 'transfer process', stage: 'in_transit',
    note: "PTT's \"TRANSFER SÜRECİNDE\": the item sent on between offices.",
  },
  {
    carrier: 'ptt', wording: 'distribution', stage: 'out_for_delivery',
    note: "PTT's \"DAĞITIMDA\": the item out with the postman. Elsewhere the word can name a distribution centre.",
  },
  {
    carrier: 'ptt', wording: 'undeliverable, address not found / left a notice', stage: 'failed_attempt',
    note: "PTT's \"TESLİM EDİLEMEDİ\" with its reason, nobody at the address and a notice left (\"Adreste Yok/Kapalı-Haber "
      + "Kağıdı Bırakıldı\"): a missed delivery. Elsewhere an address not found is a problem with the address.",
  },
  {
    carrier: 'topyou', wording: 'customs clearance warehouse entry', stage: 'in_transit',
    note: "TopYou's clearance warehouse taking the parcel in hours after its import clearance and release, as TopYou's own map "
      + "reads it and universal providers relay it. Elsewhere a parcel entering a clearance warehouse can be held for customs.",
  },
  {
    carrier: 'topyou', wording: 'customs clearance warehouse outbound', stage: 'in_transit',
    note: "The parcel leaving TopYou's clearance warehouse, cleared and released, for the delivering carrier, as TopYou's own map "
      + "reads it and universal providers relay it.",
  },
];

/** The carrier behind a scan and the provider that relayed it, when one did. */
export interface WordingScope {
  readonly carrier?: string | null;
  readonly provider?: string | null;
}

/** The stage a rule scoped to the scan's carrier, and to its provider where the rule names one, gives its whole wording. */
export function scopedWordingStage(description: string, scope: WordingScope): Stage | undefined {
  if (!scope.carrier) return undefined;
  const wording = normalizeStatusWording(description);
  return SCOPED_WORDINGS.find((rule) => rule.carrier === scope.carrier && rule.wording === wording
    && (!rule.providers || (!!scope.provider && rule.providers.includes(scope.provider))))?.stage;
}
