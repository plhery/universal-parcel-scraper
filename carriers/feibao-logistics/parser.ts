import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { feibaoStage } from './status.js';

export const PROVIDER = 'Feibao Logistics';
/** The site's goods tracking page, whose script posts to the endpoint below; the site answers over HTTP only. */
export const FEIBAO_PAGE = 'http://www.fb56.com/GoodsTrace/indexNew';
export const FEIBAO_ENDPOINT = 'http://www.fb56.com/GoodsTrace/GetOrderAjax2';
const ZONE = 'Asia/Shanghai';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// Scans after 2015 and before 2100: anything else is a changed reply.
const EARLIEST = Date.UTC(2015, 0, 1), LATEST = Date.UTC(2100, 0, 1);

/** F and eleven digits, or twelve digits, as the waybills kuaidi.com lists for Feibao are. */
export function normalizeFeibaoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^(?:F\d{11}|\d{12})$/.test(number)) throw new InvalidInputError(PROVIDER, 'Feibao waybills are F and eleven digits, or twelve digits');
  return number;
}

/** The endpoint's JSON, or the failure a page or code in its place stands for. */
export function feibaoJson(text: string): unknown {
  // The page's script reads a bare 1 as a wrong captcha code.
  if (text.trim() === '1' || text.trim() === '"1"') throw new ChallengeError(PROVIDER, 'Feibao asked for the search page\'s captcha');
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Feibao answered with a browser check');
    throw new SchemaError(PROVIDER, 'Feibao returned an invalid reply');
  }
}

const text = (value: unknown, max = 200) => (typeof value === 'string' ? textFromHtml(value, max) : '');

/** An `/Date(ms)/` stamp as epoch milliseconds, or undefined when it is anything else. */
function millis(value: unknown): number | undefined {
  const match = typeof value === 'string' ? /^\/Date\((\d{12,14})(?:[+-]\d{4})?\)\/$/.exec(value) : null;
  const ms = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(ms) && ms >= EARLIEST && ms < LATEST ? ms : undefined;
}

/**
 * A row's wording, as the search page's script builds it from the status and the stations, without
 * the driver, the driver's phone or the masked signatory. The row's station is its location, except
 * on a signature row, where that column holds the signatory.
 */
function row(status: number, station: string, next: string, remark: string): { description: string; location?: string } | undefined {
  if (!station) return remark ? { description: remark } : undefined;
  switch (status) {
    case 1: return { description: `快件已到达【${station}】`, location: station };
    case 2: return { description: `由【${station}】发往【${next}】`, location: station };
    case 3: return { description: '正在送货', location: station };
    case 4: return { description: '已签收' };
    case 5: return { description: '已拒签', location: station };
    case 99: return { description: remark || station, location: station };
    case 70: return { description: station, location: station };
    default: return undefined;
  }
}

/**
 * The tracks the endpoint gives for one waybill: its scans with their status, station, next station
 * and instant. The reply must hold one track, for the whole waybill asked, and every row must name it.
 * The recipient, sender and goods fields beside the track are not read.
 */
export function parseFeibao(body: unknown, raw: string): CarrierResult {
  const number = normalizeFeibaoNumber(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SchemaError(PROVIDER, 'Feibao returned an invalid reply');
  const { track } = body as Record<string, unknown>;
  if (!Array.isArray(track)) throw new SchemaError(PROVIDER, 'Feibao returned an invalid reply');
  if (!track.length) throw new NotFoundError(PROVIDER);
  if (track.length !== 1 || !track[0] || typeof track[0] !== 'object') throw new SchemaError(PROVIDER, 'Feibao returned another waybill');
  const { ConsignID, GoodsTrackObject } = track[0] as Record<string, unknown>;
  if (typeof ConsignID !== 'string' || ConsignID.toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Feibao returned another waybill');
  if (!Array.isArray(GoodsTrackObject) || GoodsTrackObject.length > 500) throw new SchemaError(PROVIDER, 'Feibao returned an invalid history');
  const events: { millis: number; event: CarrierEvent }[] = [], seen = new Set<string>();
  for (const scan of GoodsTrackObject as unknown[]) {
    if (!scan || typeof scan !== 'object') throw new SchemaError(PROVIDER, 'Feibao returned an invalid history row');
    const { ConsignID: waybill, BillType, Status, StationName, NextStationName, Remark, operTime } = scan as Record<string, unknown>;
    if (typeof waybill !== 'string' || waybill.toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Feibao returned a scan of another waybill');
    // The page shows only waybill rows (bill type 0).
    if (BillType !== 0) continue;
    const ms = millis(operTime);
    if (ms === undefined || typeof Status !== 'number' || !Number.isSafeInteger(Status)) throw new SchemaError(PROVIDER, 'Feibao returned an invalid scan');
    const built = row(Status, text(StationName, 80), text(NextStationName, 80), text(Remark, 300));
    if (!built) continue;
    const code = String(Status), stage = feibaoStage(code);
    const event: CarrierEvent = { time: DateTime.fromMillis(Math.floor(ms / 1000) * 1000, { zone: ZONE }).toISO({ suppressMilliseconds: true })!,
      description: built.description, provider_code: code, ...(built.location ? { location: built.location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push({ millis: ms, event }); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // Newest first; rows at the same instant keep the endpoint's order reversed.
  const sorted = events.reverse().sort((a, b) => b.millis - a.millis).map(({ event }) => event);
  const newest = sorted[0]!;
  const stage = newest.stage as ReturnType<typeof feibaoStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.location ? `${newest.description} · ${newest.location}` : newest.description,
    last_update: newest.time!, events: sorted.slice(0, 200) };
}
