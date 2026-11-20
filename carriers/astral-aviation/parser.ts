import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { astralStage } from './status.js';

const carrier = 'astral-aviation';

export function parseTracking(text: string, number: string): CarrierResult {
  if (!text.trim()) throw new IndeterminateError(carrier, 'Astral Aviation returned an empty lookup');
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Astral Aviation returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'Astral Aviation returned invalid tracking JSON');
  }
  if (!isRecord(reply) || !Array.isArray(reply.messageDetails) || reply.messageDetails.length > 500) {
    throw new SchemaError(carrier, 'Astral Aviation changed its waybill record');
  }
  if (reply.awbNo !== number) throw new IndeterminateError(carrier, 'Astral Aviation returned a different air waybill');

  const current = clean(reply.status, 150);
  const stage = astralStage(null, current);
  const history: { event: CarrierEvent; timestamp: number }[] = [];
  for (const row of reply.messageDetails as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(carrier, 'Astral Aviation changed its message history');
    // The reply includes a booking row without a waybill and cancelled messages.
    if (!row.awbno || row.isCancelled === 'Y') continue;
    if (row.awbno !== number) throw new IndeterminateError(carrier, 'Astral Aviation returned a message for a different waybill');
    const code = clean(row.messageType, 50);
    const description = clean(row.statusdesc, 150);
    if (!code || !description) throw new SchemaError(carrier, 'Astral Aviation changed its message fields');
    const rowStage = astralStage(code, description);
    const event: CarrierEvent = {
      description, provider_code: code, ...(rowStage && { stage: rowStage, stage_source: 'explicit_mapping' }),
    };

    if (row.actionDate) {
      const time = explicitOffsetTime(row.actionDate);
      if (!time) throw new SchemaError(carrier, 'Astral Aviation returned an invalid message timestamp');
      const origin = code === 'FSUDEP' ? clean(row.origin, 8) : '';
      history.push({ event: { ...event, time: time.iso, ...(/^[A-Z]{3}$/.test(origin) && { location: origin }) },
        timestamp: time.timestamp });
      continue;
    }
    if (!row.messageDate) continue;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(row.messageDate, 10));
    const day = match && calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!day) throw new SchemaError(carrier, 'Astral Aviation returned an invalid message date');
    history.push({ event: { ...event, local_time: day }, timestamp: Date.parse(day) });
  }

  history.reverse().sort((a, b) => b.timestamp - a.timestamp);
  const events = history.slice(0, 100).map(row => row.event);
  const latest = events[0];
  if (!current && !latest) throw new IndeterminateError(carrier, 'Astral Aviation omitted the shipment status');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: current || latest?.description,
    last_update: latest?.time ?? null,
    ...(latest?.local_time && { last_update_local: latest.local_time }),
    expected_delivery: null, events,
    ...(!events.length && { summary_only: true }),
    ...(history.length > 100 && { history_truncated: true }),
  };
}
