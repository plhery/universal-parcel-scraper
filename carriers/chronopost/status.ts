import { classifyWording, type ClassifiedWording } from '../../core/status/index.js';

const observed = new Map<string, { label: string; stage: ClassifiedWording['stage'] }>([
  ['DC', { label: "Colis en cours de préparation chez l'expéditeur", stage: 'registered' }],
  ['DB', { label: "Colis déposé par l'expéditeur", stage: 'accepted' }],
  ['SC', { label: "Tri effectué dans l'agence de départ", stage: 'in_transit' }],
  ['TS', { label: "Colis en cours d'acheminement", stage: 'in_transit' }],
  ['O', { label: "Colis en cours d'acheminement", stage: 'in_transit' }],
  ['TP', { label: "Colis en cours d'acheminement", stage: 'in_transit' }],
]);

export function isChronopostNotification(label: string): boolean {
  return label === 'Destinataire informé par SMS ou mail';
}

/** Partner events can reuse codes; the observed wording must agree with the code. */
export function chronopostStage(code: string, label: string): ClassifiedWording {
  const known = observed.get(code);
  if (known?.label === label) return { stage: known.stage, source: 'carrier_map' };
  return classifyWording(label, 'pending');
}
