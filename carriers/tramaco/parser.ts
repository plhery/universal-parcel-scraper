import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { ignoredTramacoWording, publicTramacoWording, tramacoStage } from './status.js';

export const PROVIDER = 'Tramaco Express';
export const TRAMACO_MAX_BYTES = 400_000;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function normalizeTramacoNumber(raw: string): string {
  const number = raw.length <= 80 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{15}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Tramaco tracking takes a fifteen-digit guide');
  return number;
}

export function tramacoTrackingUrl(raw: string): string {
  const url = new URL('https://www.tramaco.com.ec/apis/tracking_web.php');
  url.searchParams.set('campo', 'guia');
  url.searchParams.set('valor', normalizeTramacoNumber(raw));
  return url.href;
}

function scanClock(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{2}\/\d{2}\/20\d{2} \d{2}:\d{2}$/.test(raw)) {
    throw new SchemaError(PROVIDER, 'Tramaco changed its scan clock');
  }
  const date = DateTime.fromFormat(raw, 'dd/MM/yyyy HH:mm', { zone: 'UTC' });
  if (!date.isValid || date.toFormat('dd/MM/yyyy HH:mm') !== raw) throw new SchemaError(PROVIDER, 'Tramaco returned an invalid scan calendar');
  return date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** Follow the official client's parcel milestones, not its document-container bookkeeping. */
export function parseTramaco(text: string, raw: string, httpStatus = 200): CarrierResult {
  const number = normalizeTramacoNumber(raw);
  if (/_cf_chl_opt|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'Tramaco returned a browser check');
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    if (httpStatus !== 200) throw new TransportError(PROVIDER, 'Tramaco tracking is unavailable', { status: httpStatus });
    throw new SchemaError(PROVIDER, 'Tramaco returned unreadable tracking data');
  }
  if (httpStatus === 502 && record(data) && record(data.cuerpoRespuesta) && data.cuerpoRespuesta.codigo === 502
      && data.cuerpoRespuesta.mensaje === 'No se encontró ninguna transacción asociada a la guía No. : ' + number) {
    throw new NotFoundError(PROVIDER);
  }
  if (httpStatus !== 200) throw new TransportError(PROVIDER, 'Tramaco tracking is unavailable', { status: httpStatus });
  if (!record(data) || !record(data.cuerpoRespuesta) || data.cuerpoRespuesta.codigo !== '1' || data.cuerpoRespuesta.mensaje !== 'EXITO'
      || !record(data.transaccion) || typeof data.transaccion.guia !== 'string') {
    throw new SchemaError(PROVIDER, 'Tramaco changed its guide response');
  }
  if (data.transaccion.guia !== number) throw new IndeterminateError(PROVIDER, 'Tramaco did not confirm the whole requested guide');
  if (!Array.isArray(data.lstSalidaTrackGuiaWs) || data.lstSalidaTrackGuiaWs.length > 500) throw new SchemaError(PROVIDER, 'Tramaco changed its history');
  const events: CarrierEvent[] = [];
  for (const value of data.lstSalidaTrackGuiaWs as unknown[]) {
    if (!record(value) || typeof value.descripcion !== 'string' || value.descripcion.length > 1000) throw new SchemaError(PROVIDER, 'Tramaco changed a milestone');
    if (ignoredTramacoWording(value.descripcion)) continue;
    const description = publicTramacoWording(value.descripcion), staged = tramacoStage(description);
    if (!staged) throw new SchemaError(PROVIDER, 'Tramaco returned an unsupported milestone');
    events.push({ time: scanClock(value.fechaHora), description, stage: staged.stage, stage_source: staged.source });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Tramaco returned no parcel milestones');
  events.sort((a, b) => b.time!.localeCompare(a.time!));
  const newest = events[0]!, staged = tramacoStage(newest.description!)!;
  return { status: languageStageStatus(staged.stage), current_stage: staged.stage, current_stage_source: staged.source,
    last_status_text: newest.description, last_update: null, last_update_local: newest.time, expected_delivery: null,
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
