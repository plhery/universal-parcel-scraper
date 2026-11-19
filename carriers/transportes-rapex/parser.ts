import { parseCourierPortal, type CourierPortalTenant } from '../logisimple/portal.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { classifyWording, type Stage } from '../../core/status/index.js';

const states = new Map<string, Stage>([
  ['pendente', 'registered'], ['entrada em rede', 'in_transit'], ['em recolha', 'registered'],
  ['recolhido', 'accepted'], ['aceite', 'accepted'], ['em transporte', 'in_transit'],
  ['em distribuição', 'out_for_delivery'], ['entregue', 'delivered'],
]);

export const rapex: CourierPortalTenant = {
  carrier: 'transportes-rapex', provider: 'Transportes Rapex', origin: 'https://transportes-rapex.pt',
  layout: /^\d{12}$/, layoutMessage: 'Enter a twelve-digit Rapex shipment code',
  // A state the map leaves out falls to the shared wording rules, then its explanation, as Logisimple's own.
  stage(state, detail) {
    const stage = states.get(normalizeStatusWording(state));
    if (stage) return { stage, source: 'carrier_map' };
    for (const wording of [state, detail]) {
      const worded = wording ? classifyWording(wording, 'in_transit') : null;
      if (worded && worded.source !== 'none') return worded;
    }
    return null;
  },
};

export const parseRapex = (html: string, number: string) => parseCourierPortal(html, number, rapex);
