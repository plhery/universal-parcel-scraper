import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'alfa-mensajes';

export function parseTracking(raw: string, number: string, httpStatus: number): CarrierResult {
  if (/<title>\s*(?:Access Denied|Just a moment|Security Check)|cf-chl|_Incapsula_Resource/i.test(raw)) {
    throw new ChallengeError(provider, 'Alfa Mensajes requires verification');
  }
  let reply: unknown;
  try { reply = JSON.parse(raw); } catch { throw new SchemaError(provider, 'Alfa Mensajes did not return tracking JSON'); }
  if (!isRecord(reply)) throw new SchemaError(provider, 'Alfa Mensajes returned a malformed guide reply');
  if (httpStatus === 404 && reply.statusCode === 404 && reply.success === false
      && reply.message === 'Notificación no encontrada por GuiaId') throw new NotFoundError(provider);
  const guide = reply.data;
  if (reply.success !== true || !isRecord(guide) || typeof guide.guia !== 'string' || typeof guide.estado !== 'string'
      || !guide.estado.trim() || !Array.isArray(guide.historial)) {
    throw new SchemaError(provider, 'Alfa Mensajes omitted the guide or its history');
  }
  if (guide.guia !== number || guide.tipoEnvio !== 'Fisico') {
    throw new IndeterminateError(provider, 'Alfa Mensajes did not confirm the exact physical guide');
  }
  const events = guide.historial.flatMap((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(provider, 'Alfa Mensajes returned a malformed history row');
    if (row.tipoEvento !== 'estado' && row.tipoEvento !== 'asignacion') return [];
    if (typeof row.estado !== 'string' || !row.estado.trim() || typeof row.fechaUtc !== 'string'
        || !row.fechaUtc.endsWith('Z') || !DateTime.fromISO(row.fechaUtc).isValid) {
      throw new SchemaError(provider, 'Alfa Mensajes returned an invalid status movement');
    }
    const description = row.estado.trim();
    const stage = scanStage(description);
    return [{
      time: row.fechaUtc, description, provider_code: description,
      ...(stage && { stage, stage_source: 'carrier_map' }),
    }];
  }).sort((left, right) => Date.parse(right.time) - Date.parse(left.time));

  const wording = guide.estado.trim();
  const stage = scanStage(wording);
  const latest = events.find(event => event.provider_code.toLowerCase() === wording.toLowerCase());
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: wording,
    provider_code: wording,
    ...(latest && { last_update: latest.time }),
    ...(stage === 'delivered' && latest && { delivered_at: latest.time }),
    ...(events.length && { events }),
  };
}
