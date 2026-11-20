import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map(statuses.entries.map(row => [normalizeStatusWording(row.wording), row.stage as Stage]));

export function publicTramacoWording(raw: string): string {
  const wording = raw.replace(/\s+/g, ' ').trim();
  // A native delivery scan appends the signer and an identity value after this action.
  return /^(?:GUIA ENTREGADA|GUIA ENTREGADA\s*-.{1,160}?\s*-\s*\d{6,20})$/i.test(wording) ? 'GUIA ENTREGADA' : wording;
}

export function ignoredTramacoWording(raw: string): boolean {
  const wording = raw.replace(/\s+/g, ' ').trim();
  return /^(?:CS - GUIA COLOCADA EN CONTENEDOR CONTRATOS|CI - GUIA RETIRADA DE CONTENEDOR CONTRATOS)(?:\s|$)/i.test(wording)
    || /^(?:DR - INGRESO DE RUTA|INICIO RUTA DE RETIRO)$/i.test(wording);
}

export function tramacoStage(raw: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(publicTramacoWording(raw)));
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => tramacoStage(wording)?.stage, gaps: [
  ...['CS - GUIA COLOCADA EN CONTENEDOR CONTRATOS CONTRATOS QUITO MATRIZ-QUITO',
    'CS - GUIA COLOCADA EN CONTENEDOR CONTRATOS AGENCIA MANTA AGENCIA MANTA',
    'CI - GUIA RETIRADA DE CONTENEDOR CONTRATOS CONTRATOS QUITO MATRIZ-QUITO',
    'DR - INGRESO DE RUTA', 'INICIO RUTA DE RETIRO'].map(wording => ({
    wording: normalizeStatusWording(wording), note: 'The native parcel timeline omits this document or route-bookkeeping entry.' })),
] };
