import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cootranstameStage } from './status.js';

const carrier = 'cootranstame';
export const SEARCH_URL = 'https://www.cootranstame.com/rastreo-envios';

function checkChallenge(text: string): void {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'CootransTame returned a browser check');
  }
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'CootransTame returned invalid tracking JSON');
  }
}

export function readForm(html: string): {
  token: string;
  fingerprint: Record<string, unknown>;
  serverMemo: Record<string, unknown>;
} {
  checkChallenge(html);
  const $ = load(html);
  const form = $('div[wire\\:initial-data]').filter((_, element) => $(element).find('input[wire\\:model\\.defer="guia"]').length === 1);
  const snapshot = readJson(form.attr('wire:initial-data') ?? '');
  const token = form.find('input[name="_token"]').attr('value');
  if (form.length !== 1 || !token || !/^[a-z0-9]{32,128}$/i.test(token)
    || !isRecord(snapshot) || !isRecord(snapshot.fingerprint) || !isRecord(snapshot.serverMemo)
    || snapshot.fingerprint.name !== 'traza-guia' || snapshot.fingerprint.path !== 'rastreo-envios'
    || form.find('button[wire\\:click="sendForm"]').length !== 1) {
    throw new SchemaError(carrier, 'CootransTame changed its guest tracking form');
  }

  return { token, fingerprint: snapshot.fingerprint, serverMemo: snapshot.serverMemo };
}

export function parseTracking(text: string, number: string, service: string): CarrierResult {
  checkChallenge(text);
  const reply = readJson(text);
  if (!isRecord(reply) || !isRecord(reply.serverMemo) || !isRecord(reply.serverMemo.data)) {
    throw new SchemaError(carrier, 'CootransTame changed its tracking response');
  }
  const { guia, tipoServicio, NumeroGuia, error, dataJson } = reply.serverMemo.data;
  if (guia !== number || NumeroGuia !== number || tipoServicio !== service) {
    throw new IndeterminateError(carrier, 'CootransTame returned a different guide or service');
  }
  if (error === 'La guia no se encuentra registrada' && dataJson === null) throw new NotFoundError(carrier);
  if (!isRecord(dataJson) || dataJson.ProcesoExitoso !== true || !isRecord(dataJson.Datos)) {
    throw new SchemaError(carrier, 'CootransTame changed its guide record');
  }

  const shipment = dataJson.Datos;
  if (String(shipment.NumeroDocumento) !== number) {
    throw new IndeterminateError(carrier, 'CootransTame returned shipment data for a different guide');
  }
  if (!Array.isArray(shipment.Trazabilidad) || shipment.Trazabilidad.length === 0 || shipment.Trazabilidad.length > 500) {
    throw new SchemaError(carrier, 'CootransTame changed its scan history');
  }

  const events = (shipment.Trazabilidad as unknown[]).map((scan): CarrierEvent => {
    if (!isRecord(scan)) throw new SchemaError(carrier, 'CootransTame changed its scan fields');
    const description = clean(scan.Estado, 160);
    const location = clean(scan.Ciudad, 120);
    const time = clean(scan.Fecha, 30);
    if (!description || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(time)
      || !DateTime.fromISO(time, { zone: 'UTC' }).isValid) {
      throw new SchemaError(carrier, 'CootransTame returned an invalid scan');
    }
    const stage = cootranstameStage(description);
    return {
      local_time: time, description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
  }).reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));

  const latest = events[0]!;
  const stage = cootranstameStage(latest.description!);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 && { history_truncated: true }),
  };
}
