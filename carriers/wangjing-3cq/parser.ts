import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { wangjingStage } from './status.js';

export const PROVIDER = 'wangjing-3cq';
export const WANGJING_MAX_BYTES = 1024 * 1024;

const NUMBER = /^[A-Z0-9]{6,40}$/;
// An instant with the offset the tracker states, to the microsecond at most.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
// Bot checks a CDN or firewall could put in place of the reply, Alibaba Cloud's among them.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|acw_sc__v2|aliyun_waf|_____tmd_____|AliyunCaptcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const MAX_ROWS = 2_000;

/** The number as the tracker takes it, without spaces or dashes and in capitals. */
export function normalizeWangjingNumber(raw: string): string {
  return normalizeTrackingNumber(raw);
}

export function isWangjingNumber(number: string): boolean {
  return NUMBER.test(number);
}

export function isChallengePage(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

function json(body: string, httpStatus: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isChallengePage(body)) throw new ChallengeError(PROVIDER, 'Wangjing 3CQ answered with a browser check', { cause });
    if (httpStatus !== 200) throw new UpstreamHttpError(PROVIDER, httpStatus);
    throw new SchemaError(PROVIDER, 'Wangjing 3CQ returned a reply that is not JSON', { cause });
  }
}

/** A scan's instant, with the offset the tracker writes beside it. */
function scanTime(value: unknown): string {
  const raw = clean(value, 40);
  const parsed = INSTANT.test(raw) ? DateTime.fromISO(raw, { setZone: true }) : undefined;
  const time = parsed?.isValid ? parsed.toISO({ suppressMilliseconds: true }) : null;
  if (!time) throw new SchemaError(PROVIDER, 'Wangjing 3CQ returned an invalid scan time');
  return time;
}

function scan(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Wangjing 3CQ returned an invalid scan');
  const description = clean(row.description, 400);
  if (!description) throw new SchemaError(PROVIDER, 'Wangjing 3CQ returned a scan without a description');
  const time = scanTime(row.time);
  const code = cleanScalar(row.scanCode, 16);
  if (code && !/^[A-Za-z0-9_-]+$/.test(code)) throw new SchemaError(PROVIDER, 'Wangjing 3CQ returned an invalid scan code');
  const location = clean(row.location, 160);
  const staged = wangjingStage(code, description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time, code, description, location]), event };
}

/**
 * The reply of `POST /api/tracking/list`, the lookup 3CQ's tracking page makes with the numbers
 * in its address. `resultCode` 0 lists one entry per number asked, each with its scans newest
 * first: 3CQ's own steps in China, the air waybill's flights, Brazil's customs and the last mile
 * in Brazil. A number 3CQ holds no shipment for comes back with no scans, which the page shows
 * as having no tracking yet.
 */
export function parseWangjing(body: string, number: string, httpStatus: number): CarrierResult {
  const reply = json(body, httpStatus);
  if (httpStatus !== 200) throw new UpstreamHttpError(PROVIDER, httpStatus);
  if (!isRecord(reply) || typeof reply.resultCode !== 'number') throw new SchemaError(PROVIDER, 'Wangjing 3CQ returned an invalid envelope');
  if (reply.resultCode !== 0) {
    throw new IndeterminateError(PROVIDER, `Wangjing 3CQ refused the lookup: ${clean(reply.resultMsg, 120) || reply.resultCode}`);
  }
  if (!Array.isArray(reply.data)) throw new SchemaError(PROVIDER, 'Wangjing 3CQ returned an invalid envelope');
  const shipment = (reply.data as unknown[]).find((entry) => isRecord(entry)
    && normalizeTrackingNumber(clean(entry.trackingNumber, 64)) === number);
  if (!isRecord(shipment)) throw new IndeterminateError(PROVIDER, 'Wangjing 3CQ answered for another shipment');
  const rows = shipment.trackingItems ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Wangjing 3CQ returned invalid scans');
  if (!rows.length) throw new NotFoundError(PROVIDER);

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const { key, event } = scan(row);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // Newest first; scans at the same instant keep the tracker's order, which lists the newest first.
  const ordered = events.map((event, index) => ({ event, index, at: Date.parse(event.time!) }))
    .sort((left, right) => right.at - left.at || left.index - right.index)
    .map(({ event }) => event);

  const newest = ordered[0]!;
  const stage = newest.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? newest : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source! } : {}),
    last_status_text: newest.description!,
    ...(newest.provider_code ? { provider_code: newest.provider_code } : {}),
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    events: ordered,
  };
}
