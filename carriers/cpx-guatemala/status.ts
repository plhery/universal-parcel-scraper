import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const entries = new Map(statuses.entries.map(entry => [entry.code, entry]));
const readyText = 'Tu paquete está listo para entrega en tienda';
const paidText = 'Tu paquete ya fue pagado';
export const documentaryCodes = new Set(['RT', 'ROUTE_PAYMENT', 'APP_PAYMENT', 'CPX_PAYMENT']);

export function cpxDescription(code: string, activity: string): string {
  if ((code === 'INVOICED' && activity === readyText) || (code === 'CPX_PAYMENT' && activity === paidText)) return activity;
  if (code === 'INVOICED') return 'Listo para entrega';
  return entries.get(code)?.wording ?? 'Actualización';
}

export function cpxStage(code: string | null, wording: string): Stage | undefined {
  if (code === 'INVOICED' && normalizeStatusWording(wording) !== normalizeStatusWording(readyText)) return undefined;
  const stage = code && entries.get(code)?.stage;
  return stage ? stage as Stage : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: cpxStage,
  gaps: [
    { code: 'RT', note: 'CPX records receipt of an invoice.' },
    { code: 'CUSTOMS_COSTS_ADDED', note: 'CPX recorded charges without a confirmed delivery movement.' },
    { code: 'INVOICED', note: 'The store-collection wording is needed to confirm pickup readiness.' },
    { code: 'GUIDE_CREATED', note: 'A local guide was created and the carrier has a separate confirmed route scan.' },
    { code: 'ROUTE_PAYMENT', note: 'CPX recorded a payment.' },
    { code: 'APP_PAYMENT', note: 'CPX recorded a payment.' },
    { code: 'CPX_PAYMENT', note: 'CPX recorded a payment.' },
  ],
};
