import { isZheldorReference } from '../../core/detection/zheldor.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { zheldorGap, zheldorStage } from './status.js';

export const PROVIDER = 'Zheldorexpeditsia';
export const ZHELDOR_MAX_BYTES = 1_000_000;
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human|403 Forbidden/i;

export function normalizeZheldorNumber(raw: string): string {
  if (!isZheldorReference(raw)) throw new InvalidInputError(PROVIDER, 'JDE needs the sixteen-digit forwarding receipt reference');
  return raw.replace(/[\s-]/g, '');
}

function identity(value: unknown, number: string): boolean {
  return typeof value === 'string' && /^(?:\d{16}|\d{4}(?:-\d{4}){3})$/.test(value) && value.replace(/-/g, '') === number;
}

function clock(value: unknown): string {
  const match = typeof value === 'string' && /^(\d{2})\.(\d{2})\.(\d{4}) ([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(value);
  const day = match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!day || !match) throw new SchemaError(PROVIDER, 'JDE returned an invalid scan clock');
  return `${day}T${match[4]!.padStart(2, '0')}:${match[5]}:${match[6]}`;
}

function description(value: string, number: string): string {
  return clean(value).replaceAll(number, '[reference]')
    .replace(/(?:тел(?:ефон)?\.?|phone)\s*:?\s*\+?\d[\d() -]{6,}\d/gi, '')
    .replace(/\+\d(?:[ ()-]*\d){8,14}\b/g, '')
    .replace(/\b\d{9,}\b/g, '[reference]').trim();
}

export function parseZheldorResponse(text: string, status: number, raw: string): CarrierResult {
  const number = normalizeZheldorNumber(raw);
  if (new TextEncoder().encode(text).byteLength > ZHELDOR_MAX_BYTES) throw new SchemaError(PROVIDER, 'JDE returned an oversized reply');
  if (BLOCKED.test(text)) throw new ChallengeError(PROVIDER, 'JDE requires guest verification');
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { if (status !== 200) throw new UpstreamHttpError(PROVIDER, status); throw new SchemaError(PROVIDER, 'JDE returned unreadable tracking JSON'); }
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'JDE changed its tracking reply');
  if (data.CAPTCHA_ERROR === 1 || data.CAPTCHA_ERROR === '1') throw new ChallengeError(PROVIDER, 'JDE refused guest verification');
  if (status === 500 && typeof data.error === 'string') {
    const missing = /^TsmAPIvM\.OrderTrack: TsmAPI\.OrderTrack: The data for the given parameters \(ttn=(\d{16})\) - is not found$/.exec(data.error);
    if (missing?.[1] === number && Object.keys(data).length === 1) throw new NotFoundError(PROVIDER);
  }
  if (status !== 200) throw new UpstreamHttpError(PROVIDER, status);
  if (!identity(data.ID_TTN, number) || !Array.isArray(data.result) || data.result.length > 500 || data.error !== undefined
    || (data.CAPTCHA_ERROR !== undefined && data.CAPTCHA_ERROR !== 0 && data.CAPTCHA_ERROR !== '0')) {
    throw new SchemaError(PROVIDER, 'JDE returned another receipt or changed its history');
  }
  const events: CarrierEvent[] = [];
  for (const row of data.result) {
    if (!isRecord(row) || !identity(row.ID_TTN, number) || !/^(?:0|[1-9]\d{0,2})$/.test(String(row.HIDE))) {
      throw new SchemaError(PROVIDER, 'JDE returned an unbound or malformed scan');
    }
    // The page marks nonzero HIDE actions as erroneous, even when they have dates.
    if (String(row.HIDE) !== '0') continue;
    const code = typeof row.TIP === 'string' ? row.TIP : typeof row.TIP === 'number' && Number.isSafeInteger(row.TIP) ? String(row.TIP) : '';
    if (!code || code.length > 50 || typeof row.TEXT !== 'string' || row.TEXT.length > 500 || !row.TEXT.trim()
      || typeof row.MST_NAME !== 'string' || row.MST_NAME.length > 200) throw new SchemaError(PROVIDER, 'JDE returned a malformed scan');
    const wording = description(row.TEXT, number);
    if (!wording) throw new SchemaError(PROVIDER, 'JDE returned a scan without its wording');
    const stage = zheldorStage(wording), place = clean(row.MST_NAME, 200);
    events.push({ local_time: clock(row.DTIME), description: wording, provider_code: code,
      ...(place ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'JDE returned no valid dated history');
  let previous: Stage | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (zheldorGap(event.provider_code!, event.description!)) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
    } else previous = event.stage as Stage | undefined;
  }
  const newest = events[0]!, stage = newest.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description, provider_code: newest.provider_code, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
