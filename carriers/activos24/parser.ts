import { parseCourierPortal, type CourierPortalTenant } from '../logisimple/portal.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { classifyWording, type Stage } from '../../core/status/index.js';

const states = new Map<string, Stage>([
  ['pendente', 'registered'],
  // The central accepted the sender's order; the parcel enters the network after it.
  ['aceite', 'registered'],
  ['entrada em rede', 'in_transit'], ['aguarda expedição', 'in_transit'],
  ['em distribuição', 'out_for_delivery'], ['entregue', 'delivered'],
]);

export const activos24: CourierPortalTenant = {
  carrier: 'activos24', provider: 'Activos24', origin: 'https://activos24.com', path: '/pt/seguir-encomenda',
  // The form's examples and the codes customers quote are twelve digits.
  layout: /^\d{12}$/, layoutMessage: 'Enter a twelve-digit Activos24 shipment code',
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

export const parseActivos24 = (html: string, number: string) => parseCourierPortal(html, number, activos24);
