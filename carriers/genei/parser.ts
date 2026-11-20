import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Genei';

export function geneiNumber(input: string): string {
  const number = input.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the eight-character Genei shipment code');
  return number;
}

export function parseGenei(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || payload.status !== 1 || !Array.isArray(payload.errors) || payload.errors.length !== 0
    || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER);
  if (payload.data.length === 0) throw new NotFoundError(PROVIDER);

  const scans = payload.data.map((raw: unknown) => {
    if (!isRecord(raw) || typeof raw.codigo_envio !== 'string' || raw.codigo_envio.toUpperCase() !== number) {
      throw new SchemaError(PROVIDER, 'Genei did not identify the requested shipment');
    }
    const clock = explicitOffsetTime(raw.fecha_hora_creacion);
    const description = clean(raw.nombre_estado, 150);
    const sequence = raw.id_envios_historico_estados;
    if (!clock || typeof raw.id_estado_genei !== 'number' || !Number.isSafeInteger(raw.id_estado_genei)
      || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || !description) {
      throw new SchemaError(PROVIDER, 'Genei returned an incomplete scan');
    }
    return {
      clock, description, sequence, code: String(raw.id_estado_genei),
      detail: clean(raw.descripcion_estado, 240),
      piece: clean(raw.codigo_seguimiento, 64),
    };
  }).sort((a, b) => b.clock.timestamp - a.clock.timestamp || b.sequence - a.sequence);
  // GLS's parcel-shop deposit can produce delivered proof rows at the exact
  // timestamp of the pickup notice. The notice carries the recipient-facing stage.
  const pickups = new Set(scans.filter(scan => scan.code === '85' && scan.piece)
    .map(scan => scan.piece + ' ' + scan.clock.timestamp));
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const scan of scans) {
    if (scan.code === '3' && pickups.has(scan.piece + ' ' + scan.clock.timestamp)
      && /POD anotado|recepcionado en PS\b|NOMBRE:\s*PS\b/i.test(scan.detail)) continue;
    const key = [scan.piece, scan.clock.timestamp, scan.code, scan.description, scan.detail].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    const isCollection = scan.code === '80' && /^Recogido en Cliente$/i.test(scan.detail);
    const description = isCollection ? scan.detail : scan.description;
    const stage = statusMap.stage(scan.code, normalizeStatusWording(description));
    events.push({
      time: scan.clock.iso, description, provider_code: scan.code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    });
  }
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: lead?.time } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
