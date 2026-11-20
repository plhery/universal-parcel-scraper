import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bjaStage } from './status.js';

const carrier = 'bja-logistic';

function calendarDate(date: unknown): string | null {
  const text = clean(date, 40);
  if (!/^\d{1,2} [A-Za-z]{3} \d{4}$/.test(text)) return null;
  return DateTime.fromFormat(text, 'd MMM yyyy', { locale: 'id-ID', zone: 'UTC' }).toISODate();
}

export function parseTracking(text: string, httpStatus: number, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'BJA Logistic returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'BJA Logistic returned invalid tracking JSON');
  }
  if (httpStatus === 404 && isRecord(reply) && reply.error === 'not_found') throw new NotFoundError(carrier);
  if (httpStatus !== 200 || !isRecord(reply) || typeof reply.noResi !== 'string'
    || !Array.isArray(reply.events) || reply.events.length > 300) {
    throw new SchemaError(carrier, 'BJA Logistic changed its tracking reply');
  }
  if (reply.noResi.replace(/^0+(?=\d)/, '') !== number) {
    throw new IndeterminateError(carrier, 'BJA Logistic returned a different shipment reference');
  }

  const events: (CarrierEvent & { local_time: string; description: string; stage?: Stage })[] = [];
  for (const item of reply.events as unknown[]) {
    if (!isRecord(item)) throw new SchemaError(carrier, 'BJA Logistic changed its tracking event');
    const description = clean(item.status, 220);
    const date = calendarDate(item.waktu);
    if (!description || !date) throw new SchemaError(carrier, 'BJA Logistic changed its scan wording or date');
    const stage = bjaStage(description);
    events.push({
      description, local_time: date,
      ...(description === 'Barang Diterima di Warehouse Bekasi' && { location: 'Bekasi' }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    });
  }
  events.reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(carrier, 'BJA Logistic returned no shipment history');

  const estimate = calendarDate(reply.estimasiTiba);
  const service = clean(reply.layanan, 80);
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage && { current_stage: latest.stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: estimate, ...(service && { service_name: service }),
    ...(reply.estimasiTiba && !estimate ? { unread_estimates: ['estimasiTiba'] } : {}),
    events: events.slice(0, 100), ...(events.length > 100 && { history_truncated: true }),
  };
}
