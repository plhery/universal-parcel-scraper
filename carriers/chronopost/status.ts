import { classifyWording, type ClassifiedWording } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const observed = new Map<string, { label: string; stage: ClassifiedWording['stage'] }>([
  ['DC', { label: "Colis en cours de préparation chez l'expéditeur", stage: 'registered' }],
  ['DB', { label: "Colis déposé par l'expéditeur", stage: 'accepted' }],
  ['SC', { label: "Tri effectué dans l'agence de départ", stage: 'in_transit' }],
  ['TS', { label: "Colis en cours d'acheminement", stage: 'in_transit' }],
  ['O', { label: "Colis en cours d'acheminement", stage: 'in_transit' }],
  ['TP', { label: "Colis en cours d'acheminement", stage: 'in_transit' }],
  ['T', { label: "Entrée dans l'agence", stage: 'in_transit' }],
  ['TT', { label: 'Colis remis par le relais Pickup au chauffeur', stage: 'in_transit' }],
  ['EI', { label: 'Colis entré dans le pays de destination', stage: 'in_transit' }],
  ['A2', { label: "Colis retardé à l'agence de distribution", stage: 'in_transit' }],
  ['IS', { label: 'Livraison prévue lundi prochain', stage: 'in_transit' }],
  ['P', { label: "Echec de livraison suite à l'absence du destinataire.", stage: 'failed_attempt' }],
  ['SK', { label: "Colis en attente d'informations complémentaires de votre part", stage: 'exception' }],
]);

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
  const known = observed.get(code);
  if (known?.label === label) return { stage: known.stage, source: 'carrier_map' };
  return classifyWording(label, 'pending');
}

/** What the map says about one scan: a code whose observed wording it carries. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const known = code ? observed.get(code) : undefined;
    return known && normalizeStatusWording(known.label) === wording ? known.stage : undefined;
  },
  gaps: [{
    code: 'SM', wording: normalizeStatusWording(NOTIFICATION),
    note: 'A notice to the recipient, not a scan: it keeps the stage the parcel already had.',
  }],
};
