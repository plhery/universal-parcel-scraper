import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochMillisTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { hotwmsStage, statusMap } from './status.js';

export const PROVIDER = 'HOTWMS';
export const CARRIER = 'hotwms';
// A parcel's history is under a kilobyte.
export const HOTWMS_MAX_BYTES = 256 * 1024;
// Letters and digits, with a digit: the public sample is nineteen digits. The number goes into the path.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// The row that hands the parcel to the carrier of the last leg, by name in brackets and number: "已交付末段 [EMS]: …".
const LAST_LEG = /^已交付末段\s*[[【]\s*([^\]】]{1,40}?)\s*[\]】]\s*[:：]?\s*([A-Za-z0-9]{6,40})?\s*$/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 200;
// 2010-01-01T00:00:00Z: no scan is older than the firm.
const EARLIEST = 1_262_304_000_000;

/** A HOTWMS waybill, without spaces or hyphens. */
export function normalizeHotwmsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HOTWMS waybills are 6 to 40 letters and digits');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

function text(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid step`);
  return clean(value, maxLength);
}

/** The last leg's carrier, by catalog id, and its number, when a row names EMS and China Post's own rules take the number. */
function lastLeg(description: string, number: string): { carrier: string; number: string } | null {
  const named = LAST_LEG.exec(description);
  if (!named || !named[2] || named[1]!.toUpperCase() !== 'EMS') return null;
  const reference = normalizeTrackingNumber(named[2]);
  if (reference === number) return null;
  const match = detectCarrierMatch(reference);
  return match.confidence === 'high' && match.carrier === 'china-post' ? { carrier: 'china-post', number: reference } : null;
}

/**
 * HOTWMS's history for one waybill, newest first: the reply of
 * `GET https://api.hotwms.com/tracking/{number}`, `{ts, body: {tn, steps}}`.
 * `body.tn` must be the whole number asked. Each step's `ts` is an instant in
 * epoch milliseconds, which the tracking page shows on China's clock. The last
 * step names the carrier of the last leg in brackets and its number: China
 * Post becomes the delivery carrier when the bracket says EMS and China Post's
 * own rules take the whole number.
 */
export function parseHotwms(payload: unknown, raw: string): CarrierResult {
  const number = normalizeHotwmsNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  // The page shows `errMsg` for these, never an empty history.
  if (payload.errCode !== undefined || payload.errorMessage !== undefined || payload.errMsg !== undefined) {
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  const body = payload.body;
  if (!isRecord(body) || typeof body.tn !== 'string' || !Array.isArray(body.steps)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (normalizeTrackingNumber(body.tn) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  // The service's answer for a number it holds nothing under: the number and no step.
  if (body.steps.length === 0) throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
  if (body.steps.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);

  const seen = new Set<string>();
  const rows: { at: number; index: number; event: CarrierEvent }[] = [];
  for (const [index, step] of (body.steps as unknown[]).entries()) {
    if (!isRecord(step)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid step`);
    const time = Number.isSafeInteger(step.ts) && (step.ts as number) >= EARLIEST ? epochMillisTime(step.ts) : null;
    if (!time) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid step time`);
    const description = text(step.desc, 300);
    if (!description) continue;
    const location = text(step.place, 120);
    const key = JSON.stringify([time.timestamp, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = hotwmsStage(description);
    rows.push({ at: time.timestamp, index, event: {
      time: time.iso, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  // Newest first; steps at one instant keep the reply's order, which lists the newer first.
  const events = rows.sort((left, right) => right.at - left.at || left.index - right.index).map((row) => row.event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const handoff = events.map((event) => lastLeg(event.description!, number)).find((leg) => leg !== null);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    expected_delivery: null,
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}
