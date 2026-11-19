import { parseCourierPortal, type CourierPortalTenant } from '../logisimple/portal.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import type { Stage } from '../../core/status/index.js';

const states = new Map<string, Stage>([
  ['pendente', 'registered'], ['entrada em rede', 'in_transit'], ['em recolha', 'registered'],
  ['recolhido', 'accepted'], ['aceite', 'accepted'], ['em transporte', 'in_transit'],
  ['em distribuição', 'out_for_delivery'], ['entregue', 'delivered'],
]);

export const rapex: CourierPortalTenant = {
  carrier: 'transportes-rapex', provider: 'Transportes Rapex', origin: 'https://transportes-rapex.pt',
  layout: /^\d{12}$/, layoutMessage: 'Enter a twelve-digit Rapex shipment code',
  stage(state) {
    const stage = states.get(normalizeStatusWording(state));
    return stage ? { stage, source: 'carrier_map' } : null;
  },
};

export const parseRapex = (html: string, number: string) => parseCourierPortal(html, number, rapex);
