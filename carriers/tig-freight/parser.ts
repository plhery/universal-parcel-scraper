import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, mislabeledWallTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { stageForWording } from './status.js';

export const provider = 'tig-freight';

interface Shipment {
  shipmentReferenceId?: unknown;
  tracking?: {
    timestamp?: unknown;
    level0?: { name?: unknown };
    level1?: { name?: unknown };
    location?: unknown;
  }[];
}

interface Reply {
  errors?: { message?: unknown; code?: unknown }[];
  data?: { shipment?: Shipment | null } | null;
}

export function parseTracking(body: unknown, reference: string): CarrierResult {
  if (!body || typeof body !== 'object') throw new SchemaError(provider, 'Invalid Open360 reply');
  const reply = body as Reply;
  if (Array.isArray(reply.errors) && reply.errors.length) {
    if (reply.data === null && reply.errors.every(error => error?.message === 'Shipment not found')) {
      throw new NotFoundError(provider);
    }
    if (reply.errors.some(error => /^(?:RATE_LIMITED|TOO_MANY_REQUESTS)$/.test(clean(error?.code)))) {
      throw new RateLimitedError(provider);
    }
    if (reply.errors.some(error => /captcha|verification required/i.test(clean(error?.message)))) {
      throw new ChallengeError(provider, 'Open360 requires verification');
    }
    throw new SchemaError(provider, 'Open360 shipment query failed');
  }
  const shipment = reply.data?.shipment;
  if (!shipment || !Array.isArray(shipment.tracking)) throw new SchemaError(provider, 'Missing Open360 shipment');
  const identity = clean(shipment.shipmentReferenceId);
  if (!identity) throw new SchemaError(provider, 'Missing Open360 shipment reference');
  if (identity.toUpperCase() !== reference.toUpperCase()) {
    throw new IndeterminateError(provider, 'Open360 returned a different shipment reference');
  }

  // The tracker displays the timeline starting from the last row.
  const events: (CarrierEvent & { stage?: Stage })[] = shipment.tracking.slice().reverse().map(scan => {
    const description = clean(scan?.level1?.name) || clean(scan?.level0?.name);
    const value = clean(scan?.timestamp);
    const instant = explicitOffsetTime(value);
    const wallClock = !instant && /^\d{4}-\d{2}-\d{2}T/.test(value) ? mislabeledWallTime(value) : null;
    if (!description || (!instant && !wallClock)) throw new SchemaError(provider, 'Invalid Open360 scan');
    const location = clean(scan.location);
    const stage = stageForWording(description);
    return {
      description,
      ...(instant ? { time: instant.iso } : { local_time: wallClock! }),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  });
  const newest = events[0];
  if (!newest) throw new NoHistoryError(provider);
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    ...(newest.time ? { last_update: newest.time } : { last_update_local: newest.local_time }),
    events,
  };
}
