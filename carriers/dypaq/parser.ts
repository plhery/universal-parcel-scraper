import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dypaqRequestNumber } from './number.js';
import { dypaqStage } from './status.js';

export const PROVIDER = 'DYPAQ';
// A reply is a few kilobytes; a delivered one also holds the signature as a small image.
export const DYPAQ_MAX_BYTES = 2 * 1024 * 1024;
// "2023-11-28T20:32:54.987": a wall clock, with or without milliseconds, and no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
// A CDN's or firewall's page in place of the service's reply, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A movement's clock, to the second, as the wall clock DYPAQ wrote it. */
function wallClock(value: unknown): string {
  const parts = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) {
    throw new SchemaError(PROVIDER, 'DYPAQ returned an invalid movement time');
  }
  return `${day}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

/** A movement's wording: its text without the map link some movements carry. */
function wording(value: unknown): string {
  if (typeof value !== 'string') return '';
  const fragment = load(value, null, false);
  fragment('a').remove();
  return clean(fragment.root().text(), 200);
}

/** The value of a line of the delivery block, by its label without the colon. */
function deliveryValue(lines: unknown[], label: string): unknown {
  const line = lines.find((entry) => isRecord(entry) && clean(entry.Descripcion, 60).replace(/:$/, '').trim().toLowerCase() === label);
  return isRecord(line) ? line.Valor : undefined;
}

/**
 * The reply of `POST /wp-json/dypaq_services/v1/tracking` for one guía: a
 * delivery block that names the guía and, once delivered, who took it, and
 * the movements newest first, each naming the guía. A guía DYPAQ does not
 * hold gets the block naming it and no movements. Only movements naming the
 * whole guía asked are read; the recipient's details, the signature and the
 * comments under movements are not.
 */
export function parseDypaq(body: string, raw: string): CarrierResult {
  const number = dypaqRequestNumber(raw);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DYPAQ answered with a browser check');
    throw new SchemaError(PROVIDER, 'DYPAQ returned an invalid tracking reply');
  }
  if (!isRecord(payload) || payload.return_code !== 200 || !isRecord(payload.result)) {
    throw new SchemaError(PROVIDER, 'DYPAQ returned an unexpected tracking reply');
  }
  if (Array.isArray(payload.errors) && payload.errors.length) throw new SchemaError(PROVIDER, 'DYPAQ answered with an error');
  const { delivery, tracking } = payload.result;
  if (!Array.isArray(delivery) || !Array.isArray(tracking)) throw new SchemaError(PROVIDER, 'DYPAQ returned an unexpected tracking reply');
  if (tracking.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DYPAQ returned an oversized history');
  const named = clean(deliveryValue(delivery, 'guia'), 64).toUpperCase();
  if (!tracking.length) {
    if (named !== number) throw new SchemaError(PROVIDER, 'DYPAQ did not look the guía up');
    throw new NotFoundError(PROVIDER);
  }

  const seen = new Set<string>();
  const listed: { event: CarrierEvent; order: number }[] = [];
  for (const [order, row] of tracking.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DYPAQ returned an invalid movement');
    if (clean(row.GUIA, 64).toUpperCase() !== number) continue;
    const description = wording(row.Movimiento);
    if (!description) throw new SchemaError(PROVIDER, 'DYPAQ returned a movement without wording');
    const local_time = wallClock(row.FechaCaptura);
    const location = clean(row.Oficina, 80);
    const key = JSON.stringify([local_time, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = dypaqStage(description);
    listed.push({ order, event: { local_time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } });
  }
  // Movements, none of them naming the guía asked, are about another shipment.
  if (!listed.length) throw new IndeterminateError(PROVIDER, 'DYPAQ answered for another shipment');
  // Newest first, as the reply lists them; movements of the same second keep its order.
  listed.sort((left, right) => (right.event.local_time! > left.event.local_time! ? 1 : right.event.local_time! < left.event.local_time! ? -1
    : left.order - right.order));
  const events = listed.map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
