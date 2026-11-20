import { IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { stageForTitle } from './status.js';

export const provider = 'rocket-shipping';

interface Reply {
  loadNumber?: unknown;
  friendly?: { events?: { date?: unknown; title?: unknown; description?: unknown }[] } | null;
  trackingNotes?: { createdDateUtc?: unknown; notes?: unknown }[];
}

export function parseTracking(body: unknown, number: string): CarrierResult {
  if (!body || typeof body !== 'object') throw new SchemaError(provider, 'Invalid Rocket Shipping reply');
  const reply = body as Reply;
  const identity = cleanScalar(reply.loadNumber);
  if (!identity) throw new SchemaError(provider, 'Missing Rocket Shipping load number');
  if (identity !== number) throw new IndeterminateError(provider, 'Rocket Shipping returned another load');

  const friendly = reply.friendly?.events;
  const notes = reply.trackingNotes;
  if ((friendly != null && !Array.isArray(friendly)) || (notes != null && !Array.isArray(notes))) {
    throw new SchemaError(provider, 'Invalid Rocket Shipping scan list');
  }
  if (!friendly && !notes) throw new SchemaError(provider, 'Missing Rocket Shipping scan list');
  const scans = friendly?.length
    ? friendly.map(row => ({ time: row?.date, title: clean(row?.title), description: clean(row?.description) }))
    : (notes ?? []).map(row => ({ time: row?.createdDateUtc, title: '', description: clean(row?.notes) }));
  const events = scans.map(({ time, title, description }) => {
    const clock = explicitOffsetTime(time);
    const wording = description || title;
    if (!clock || !wording) throw new SchemaError(provider, 'Invalid Rocket Shipping scan');
    const stage = stageForTitle(title);
    const event: CarrierEvent & { stage?: Stage } = {
      description: wording, time: clock.iso,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { event, timestamp: clock.timestamp };
  }).sort((a, b) => b.timestamp - a.timestamp).map(scan => scan.event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(provider);
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: newest.time, events,
  };
}
