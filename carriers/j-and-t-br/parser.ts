import { isJAndTBrReference } from '../../core/detection/jAndTBr.js';
import { ChallengeError, InvalidInputError, NoHistoryError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { isJAndTBrPageLine, jAndTBrStage } from './status.js';
export const PROVIDER = 'J&T Express Brazil';
export const JT_BR_PAGE = 'https://www.jtexpress.com.br/trajectoryQuery';
export const JT_BR_API = 'https://official.jtjms-br.com/official/logisticsTracking/queryPodTracking';
export const JT_BR_MAX_BYTES = 1_000_000;
export function normalizeJAndTBrNumber(raw: string): string {
  if (!isJAndTBrReference(raw)) throw new InvalidInputError(PROVIDER, 'J&T Brazil needs its fifteen-digit domestic waybill');
  return raw.trim();
}
function clock(raw: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  const m = typeof raw === 'string' && /^(20\d{2})[-/](\d{2})[-/](\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  const day = m && calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!m || !day) throw new SchemaError(PROVIDER, 'J&T Brazil returned an invalid scan clock');
  const wall = `${day}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  if (!m[7]) return { local_time: wall };
  const time = wall + m[7];
  if (!explicitOffsetTime(time)) throw new SchemaError(PROVIDER, 'J&T Brazil returned an invalid stated offset');
  return { time };
}
/** The text before the first full stop outside brackets, so a centre named "[AG. EXEMPLO]" stays whole. */
function firstSentence(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '[') depth++;
    else if (char === ']') depth = Math.max(0, depth - 1);
    else if (char === '.' && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1]!))) return text.slice(0, i);
  }
  return text;
}
/**
 * The line the tracking page shows for a scan (`customerTracking`): the scan's city in brackets, then J&T's words with
 * its centres in brackets ("[City] Saída da encomenda expressa [CD A] enviada para [CD B]"). J&T's own status says
 * "Em transferencia" for every arrival and departure alike. A collection names the courier, masked, then adds a note
 * with a phone number: both are dropped. Null for a line of another shape or with nothing left, and the status stands in.
 */
function scanLine(raw: unknown): Pick<CarrierEvent, 'description' | 'location'> | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const lead = /^\s*\[([^\]]{1,60})\]\s*/.exec(raw);
  const text = firstSentence((lead ? raw.slice(lead[0].length) : raw)
    .replace(/\[[^\]]*\*[^\]]*\]/g, ' ')
    .replace(/[^\s[\]]*\*{2,}[^\s[\]]*/g, ' '))
    .replace(/\s+/g, ' ').trim();
  if (!text || /\d{6,}|https?:|[<>@*]/.test(text) || !isJAndTBrPageLine(text)) return null;
  const city = lead?.[1]!.replace(/\s+/g, ' ').trim();
  return { description: text, ...(city && !/[\d*@<>]/.test(city) ? { location: city } : {}) };
}
/** A reply's code or flag as the message shows it: a short number, word or boolean, else its type. */
function replyScalar(value: unknown): string {
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) return String(value);
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,20}$/.test(value) ? value : value === null ? 'null' : typeof value;
}
export function parseJAndTBr(data: unknown, raw: string): CarrierResult {
  const number = normalizeJAndTBrNumber(raw);
  if (isRecord(data) && data.failureKind === 'challenge') throw new ChallengeError(PROVIDER, 'J&T Brazil refused guest verification');
  if (isRecord(data) && data.failureKind === 'rate_limited') throw new RateLimitedError(PROVIDER);
  // A refusal the page's helper could not type keeps J&T's code in the message, the only trace of what it said.
  if (isRecord(data) && (data.code !== 1 || data.succ !== true)) {
    throw new SchemaError(PROVIDER, `J&T Brazil answered without success (code ${replyScalar(data.code)}, succ ${replyScalar(data.succ)})`);
  }
  if (isRecord(data) && data.identityMismatch) throw new SchemaError(PROVIDER, 'J&T Brazil answered for another waybill');
  // An empty success, an empty list or none for a waybill it has no record of, has no response identity or explicit absence claim.
  if (isRecord(data) && (data.data === null || (Array.isArray(data.data) && data.data.length === 0))) {
    throw new NoHistoryError(PROVIDER, 'J&T Brazil returned no dated history');
  }
  if (!isRecord(data) || !Array.isArray(data.data) || data.data.length > 1) throw new SchemaError(PROVIDER, 'J&T Brazil changed its guest tracking reply');
  const record: unknown = data.data[0];
  if (!isRecord(record) || record.keyword !== number || !Array.isArray(record.details) || record.details.length > 1000) {
    throw new SchemaError(PROVIDER, 'J&T Brazil returned another waybill or changed its history');
  }
  const events: CarrierEvent[] = record.details.map((value: unknown) => {
    if (!isRecord(value) || typeof value.status !== 'string' || !value.status.trim() || value.status.length > 120
      || /[<>@\r\n]|https?:|\d{9,}/i.test(value.status)) throw new SchemaError(PROVIDER, 'J&T Brazil changed a milestone');
    const code = typeof value.code === 'number' && Number.isSafeInteger(value.code) ? String(value.code)
      : typeof value.code === 'string' && /^[A-Z0-9_-]{1,30}$/.test(value.code) ? value.code : null;
    if (!code) throw new SchemaError(PROVIDER, 'J&T Brazil returned an invalid milestone code');
    const stage = jAndTBrStage(code);
    const line = scanLine(value.customerTracking);
    return { ...clock(value.scanTime), provider_code: code, description: line?.description ?? value.status.trim(),
      ...(line?.location ? { location: line.location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'J&T Brazil returned a waybill without dated history');
  const newest = events[0]!, stage = newest.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: newest.provider_code, last_status_text: newest.description,
    last_update: newest.time ?? null, last_update_local: newest.local_time ?? null, expected_delivery: null,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
