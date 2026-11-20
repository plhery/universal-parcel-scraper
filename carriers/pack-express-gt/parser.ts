import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst, orderComparableScans, withTieOrder } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { milestones, packStage } from './status.js';

const carrier = 'pack-express-gt';

function localClock(written: unknown): string | null {
  const clock = clean(written, 48).replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?)?$/.test(clock)) return null;
  return DateTime.fromISO(clock, { zone: 'UTC' }).isValid ? clock : null;
}

function serviceClock(date: unknown, time: unknown): string | null {
  const day = clean(date, 20);
  const minutes = clean(time, 20);
  return localClock(minutes ? day + ' ' + minutes : day);
}

type PackEvent = CarrierEvent & { description: string; stage?: Stage };

export function parseTracking(text: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Pack Express returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'Pack Express returned invalid tracking JSON');
  }
  if (!isRecord(reply) || reply.ok !== true) throw new SchemaError(carrier, 'Pack Express could not complete the lookup');
  if (reply.encontrada === false) throw new NotFoundError(carrier);
  const echoed = clean(reply.guia, 64);
  if (reply.encontrada !== true || !echoed) throw new SchemaError(carrier, 'Pack Express changed its tracking reply');
  if (echoed.toUpperCase() !== number) throw new IndeterminateError(carrier, 'Pack Express returned a different guide');

  let summary: string;
  let summaryClock: string | null = null;
  const rows: PackEvent[] = [];
  if (reply.fuente === 'z17') {
    summary = clean(reply.estado, 150);
    summaryClock = serviceClock(reply.fecha, reply.hora);
    const history: unknown = reply.historial ?? [];
    if (!Array.isArray(history) || history.length > 500) throw new SchemaError(carrier, 'Pack Express changed its service history');
    for (const item of history as unknown[]) {
      if (!isRecord(item)) throw new SchemaError(carrier, 'Pack Express changed its service history entry');
      const description = clean(item.estado, 150);
      if (!description) throw new SchemaError(carrier, 'Pack Express omitted a service history status');
      const clock = serviceClock(item.fecha, item.hora);
      const stage = packStage(null, description);
      rows.push({ description, ...(clock && { local_time: clock }), ...(stage && { stage, stage_source: 'explicit_mapping' }) });
    }
  } else {
    const route = clean(reply.estado_ruta, 150);
    summary = route || clean(reply.estado_guia, 150);
    for (const { code, wording, stage } of milestones) {
      if (reply[code] == null || reply[code] === '') continue;
      const clock = localClock(reply[code]);
      if (!clock) throw new SchemaError(carrier, 'Pack Express returned an invalid milestone date');
      rows.push({ description: wording, provider_code: code, stage, stage_source: 'explicit_mapping', local_time: clock });
    }
  }
  withTieOrder(rows);
  const newestFirst = reply.fuente === 'z17' && listsNewestFirst(rows) === true;
  const events = orderComparableScans(newestFirst ? rows : rows.reverse(), (event) => event.local_time ? 'wall' : undefined);
  const latest = events[0];
  const summaryStage = packStage(null, summary);
  const useSummary = Boolean(summary) && (reply.fuente === 'z17' || Boolean(summaryStage) || !latest);
  const stage = useSummary ? summaryStage : latest?.stage;
  const wording = useSummary ? summary || latest?.description : latest?.description;
  if (!wording) throw new IndeterminateError(carrier, 'Pack Express returned no guide status or history');
  const statusClock = summaryClock ?? (useSummary
    ? events.find((event) => event.description === summary)?.local_time : latest?.local_time);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: wording, last_update: null, ...(statusClock && { last_update_local: statusClock }),
    events: events.slice(0, 100), ...(events.length > 100 && { history_truncated: true }),
    ...(!events.length && { summary_only: true }),
  };
}
