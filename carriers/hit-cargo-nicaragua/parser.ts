import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, mislabeledWallTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { hitCargoEventStage, hitCargoStatus } from './status.js';

export const PROVIDER = 'HIT Cargo';
// Bot checks Cloudflare puts in place of the reply.
export const HIT_CARGO_CHALLENGE = /_cf_chl_opt|cf-turnstile|cf-error-details|<title>\s*Just a moment|<title>\s*Attention Required/i;
const MAX_ROWS = 200;
const POUND_KG = 0.45359237;
// A clock written to the minute is the warehouse's wall clock labeled as UTC; one written to the
// second or finer is an instant the tracker's own system wrote.
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)$/;
const SERVICES: Readonly<Record<string, string>> = { aereo: 'Aéreo', maritimo: 'Marítimo' };

/** A guía: the number of the warehouse receipt HIT Cargo gives a package in Miami. */
export function normalizeHitCargoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 32 ? raw.replace(/\s/g, '') : '';
  if (!/^\d{5,8}$/.test(number)) throw new InvalidInputError(PROVIDER, 'HIT Cargo guías are 5 to 8 digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The reply's JSON, given as it came or as the page a browser draws around it. */
function replyOf(body: string): unknown {
  if (HIT_CARGO_CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'HIT Cargo answered with a browser check');
  const text = body.trimStart().startsWith('<') ? load(body)('pre').first().text() : body;
  try { return JSON.parse(text); }
  catch { return invalid('HIT Cargo returned a reply that is not JSON'); }
}

function clockOf(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  const text = clean(value, 64);
  if (WALL_CLOCK.test(text)) {
    const wall = mislabeledWallTime(text);
    if (wall) return { local_time: wall.slice(0, 19) };
  } else {
    const instant = explicitOffsetTime(text);
    if (instant) return { time: instant.iso };
  }
  return invalid('HIT Cargo returned an invalid event clock');
}

/**
 * Reads the tracker's reply for one guía. Its events come oldest first, each with its wording,
 * its office and a clock; the package's own status code gives the current stage.
 */
export function parseHitCargo(body: string, number: string): CarrierResult {
  const reply = replyOf(body);
  if (!isRecord(reply)) return invalid('HIT Cargo returned an unknown reply');
  if (reply.ok === false) {
    const error = isRecord(reply.error) ? reply.error : {};
    const asked = /^We could not find a shipment with "([^"]*)"/.exec(clean(error.message, 300));
    if (error.code !== 'NOT_FOUND' || !asked) return invalid('HIT Cargo returned an unknown error');
    if (asked[1] !== number) throw new IndeterminateError(PROVIDER, 'HIT Cargo answered for another guía');
    throw new NotFoundError(PROVIDER, 'HIT Cargo has no package with this guía');
  }
  const data = reply.ok === true && isRecord(reply.data) ? reply.data : invalid('HIT Cargo returned an unknown reply');
  // An unknown guía may still match a courier's tracking number, which the tracker also takes.
  if (clean(data.guia, 40) !== number) throw new IndeterminateError(PROVIDER, 'HIT Cargo answered for another guía');
  const rows = Array.isArray(data.events) ? data.events : invalid('HIT Cargo returned a package without its events');
  if (rows.length > MAX_ROWS) return invalid('HIT Cargo returned too many events');

  const events: CarrierEvent[] = rows.map((row: unknown) => {
    if (!isRecord(row)) return invalid('HIT Cargo returned an unknown event');
    const description = clean(row.description, 300);
    if (!description) return invalid('HIT Cargo returned an event without its wording');
    const office = clean(row.office, 40);
    const mapped = hitCargoEventStage(description);
    const read = mapped ? null : classifyWording(description, 'in_transit');
    const stage = mapped ?? (read?.source !== 'none' ? read?.stage : undefined);
    return { ...clockOf(row.date), description, ...(office ? { location: office } : {}),
      ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : read!.source } : {}) };
  }).reverse();
  if (!events.length) throw new NoHistoryError(PROVIDER, 'HIT Cargo lists the package without its events', { reason: 'listed' });

  const code = clean(data.status, 40);
  const current = hitCargoStatus(code);
  const latest = events.find(event => event.stage);
  const stage = (current ?? latest?.stage) as Stage | undefined;
  const weight = typeof data.weightLb === 'number' && Number.isFinite(data.weightLb) && data.weightLb > 0
    ? Math.round(data.weightLb * POUND_KG * 1000) / 1000 : null;
  const service = SERVICES[clean(data.serviceType, 20)];
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current ? 'carrier_map' : latest!.stage_source } : {}),
    last_status_text: clean(data.statusLabel, 120) || newest.description || null,
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time! }),
    weight_kg: weight,
    ...(service ? { service_name: service } : {}),
    events,
  };
}
