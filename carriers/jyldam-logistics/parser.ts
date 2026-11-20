import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jyldamStage } from './status.js';

const carrier = 'jyldam-logistics';
const missingMessage = 'Отправление не найдено.';

function localClock(value: string): string | undefined {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}))?$/.exec(value);
  if (!match) return undefined;
  const day = calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!day || Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59) return undefined;
  return match[4] ? day + 'T' + match[4] + ':' + match[5] : day;
}

export function parseTracking(text: string, httpStatus: number, year: string, serial: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Jyldam returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'Jyldam returned invalid tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(carrier, 'Jyldam changed its tracking reply');
  if (httpStatus === 404 && reply.success === false && typeof reply.message === 'string'
    && reply.message.startsWith(missingMessage)) throw new NotFoundError(carrier);
  if (httpStatus !== 200 || reply.success !== true || !Array.isArray(reply.events) || reply.events.length > 100) {
    throw new SchemaError(carrier, 'Jyldam changed its shipment record');
  }
  if (reply.source !== 'jyldam') throw new IndeterminateError(carrier, 'Jyldam returned a different tracking source');
  if (reply.track_id !== 'JL-' + serial && reply.track_id !== 'JL-' + year + '-' + serial) {
    throw new IndeterminateError(carrier, 'Jyldam returned a different shipment number');
  }

  const events: CarrierEvent[] = [];
  let firstDate: string | undefined;
  for (const row of reply.events as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(carrier, 'Jyldam changed its tracking history');
    if (row.state === 'pending') continue;
    const description = clean(row.title, 120);
    const code = clean(row.raw_status, 80);
    if (!description || (row.state !== 'done' && row.state !== 'current')) {
      throw new SchemaError(carrier, 'Jyldam changed its tracking fields');
    }
    const date = clean(row.date, 10);
    const time = clean(row.time, 5);
    if (!date && !time) continue;
    const clock = localClock(time ? date + ' ' + time : date);
    if (!clock) throw new SchemaError(carrier, 'Jyldam returned an invalid local time');
    const stage = jyldamStage(code, description);
    const location = clean(row.location, 120);
    if (!firstDate || clock < firstDate) firstDate = clock;
    events.push({
      local_time: clock, description, ...(code && { provider_code: code }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
      ...(location && { location }),
    });
  }

  // Jyldam omits the year from its response label. Bind that shorter label to the
  // shipment's first dated event before using it as proof of the full reference.
  if (reply.track_id === 'JL-' + serial && firstDate?.slice(0, 4) !== year) {
    throw new IndeterminateError(carrier, 'Jyldam did not confirm the shipment year');
  }
  const wording = clean(reply.summary, 120);
  if (!wording) throw new SchemaError(carrier, 'Jyldam omitted the shipment status');
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const current = events.find(event => event.description === wording);
  const stage = jyldamStage(current?.provider_code, wording);
  const latest = events[0];

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: wording, ...(current?.provider_code && { provider_code: current.provider_code }),
    last_update: null, ...(latest?.local_time && { last_update_local: latest.local_time }),
    expected_delivery: null, events, ...(!events.length && { summary_only: true }),
  };
}
