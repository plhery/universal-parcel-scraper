import { classifyWording, type ClassifiedWording } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

type ChronopostStage = ClassifiedWording['stage'];

/** Each code with the wordings observed under it. Partner events can reuse codes, so both must agree. */
const OBSERVED: ReadonlyArray<readonly [code: string, label: string, stage: ChronopostStage]> = [
  ['DC', "Colis en cours de préparation chez l'expéditeur", 'registered'],
  // Written with the label, before the parcel is handed over: it is one of several in a shipment.
  ['EA', "Colis faisant partie d'une expédition groupée", 'registered'],
  ['DB', "Colis déposé par l'expéditeur", 'accepted'],
  ['SC', "Tri effectué dans l'agence de départ", 'in_transit'],
  ['TS', "Colis en cours d'acheminement", 'in_transit'],
  ['O', "Colis en cours d'acheminement", 'in_transit'],
  ['TP', "Colis en cours d'acheminement", 'in_transit'],
  ['T', "Entrée dans l'agence", 'in_transit'],
  ['TT', 'Colis remis par le relais Pickup au chauffeur', 'in_transit'],
  ['EI', 'Colis entré dans le pays de destination', 'in_transit'],
  ['A2', "Colis retardé à l'agence de distribution", 'in_transit'],
  ['IS', 'Livraison prévue lundi prochain', 'in_transit'],
  // The depot holds the parcel a day without trying to deliver it: a missort, an address being
  // checked, or a recipient closed that day. Delivery resumes on its own.
  ['SD', 'Livraison reportée de 24h', 'in_transit'],
  ['IA', 'Livraison reportée de 24h', 'in_transit'],
  // The round, the courier on the way to a pickup point and its arrival there. They come
  // within two minutes of the delivering partner's own scans, and La Poste's feed stages the
  // same scans alike as MD1, ET1 and AG1.
  ['TA', 'Colis en cours de livraison', 'out_for_delivery'],
  ['RB', 'Colis en cours de livraison au point de retrait', 'in_transit'],
  ['AB', 'Colis mis à disposition au point de retrait', 'ready_for_pickup'],
  ['P', "Echec de livraison suite à l'absence du destinataire.", 'failed_attempt'],
  ['SK', "Colis en attente d'informations complémentaires de votre part", 'exception'],
];

const observed = new Map<string, Map<string, ChronopostStage>>();
for (const [code, label, stage] of OBSERVED) observed.set(code, (observed.get(code) ?? new Map<string, ChronopostStage>()).set(label, stage));

const NOTIFICATION = 'Destinataire informé par SMS ou mail';

export function isChronopostNotification(label: string): boolean {
  return label === NOTIFICATION;
}

/** The courier's drop-off scan, which can follow the pickup point's own arrival scan. */
export function isPickupDropOff(code: string, label: string): boolean {
  return code === 'RB' && label === 'Colis en cours de livraison au point de retrait';
}

/** Partner events can reuse codes; the observed wording must agree with the code. */
export function chronopostStage(code: string, label: string): ClassifiedWording {
  const stage = observed.get(code)?.get(label);
  return stage ? { stage, source: 'carrier_map' } : classifyWording(label, 'pending');
}

/** What the map says about one scan: a code whose observed wording it carries. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    for (const [label, stage] of (code ? observed.get(code) : undefined) ?? []) {
      if (normalizeStatusWording(label) === wording) return stage;
    }
    return undefined;
  },
  gaps: [{
    code: 'SM', wording: normalizeStatusWording(NOTIFICATION),
    note: 'A notice to the recipient, not a scan: it keeps the stage the parcel already had.',
  }],
};
