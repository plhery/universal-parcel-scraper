import { calendarDay } from '../../core/time/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ibexStage } from './status.js';

const carrier = 'ibex-express-bo';

function localClock(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  const day = match && calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    throw new SchemaError(carrier, 'IBEX Express returned an invalid scan clock');
  }
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

function publicStatusText(description: string): string {
  return /^Envío en poder del Cartero\s*\[/i.test(description)
    ? description.split('[')[0]!.trim()
    : description;
}

export function parseTracking(text: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'IBEX Express returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'IBEX Express returned invalid tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(carrier, 'IBEX Express changed its response');
  if (reply.success === false && reply.message === 'No se encontraron resultados.' && !reply.data) {
    throw new NotFoundError(carrier);
  }
  if (reply.success !== true || !Array.isArray(reply.data) || !reply.data.length || reply.data.length > 500) {
    throw new SchemaError(carrier, 'IBEX Express changed its waybill record');
  }
  const rows: unknown[] = reply.data;
  const summary = rows[0];
  if (!isRecord(summary)) throw new SchemaError(carrier, 'IBEX Express changed its waybill summary');
  const statusText = clean(summary.estado_guia, 120);
  if (!statusText) throw new SchemaError(carrier, 'IBEX Express omitted the waybill status');
  const actualDelivery = clean(summary.fecha_entrega_real, 24);
  const stage = ibexStage(statusText);
  const events: CarrierEvent[] = [];

  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(carrier, 'IBEX Express changed its history');
    if (row.guia !== number) throw new IndeterminateError(carrier, 'IBEX Express returned a different waybill');
    const time = clean(row.fecha_bit, 24);
    const description = publicStatusText(clean(row.descripcion, 160));
    if (!time && !description) continue;
    if (!time || !description) throw new SchemaError(carrier, 'IBEX Express changed its scan fields');
    const location = clean(row.ubicacion, 100);
    const scanStage = ibexStage(description);
    events.push({
      local_time: localClock(time), description, ...(location && { location }),
      ...(scanStage && { stage: scanStage, stage_source: 'explicit_mapping' }),
    });
  }
  if (actualDelivery && stage === 'delivered') {
    const time = localClock(actualDelivery);
    if (!events.some(scan => scan.stage === 'delivered' && scan.local_time === time)) {
      events.push({ local_time: time, description: statusText, stage, stage_source: 'explicit_mapping' });
    }
  }
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: statusText, last_update: null,
    ...(events[0]?.local_time && { last_update_local: events[0].local_time }),
    expected_delivery: null, events: events.slice(0, 100),
    ...(!events.length && { summary_only: true }),
    ...(events.length > 100 && { history_truncated: true }),
  };
}
