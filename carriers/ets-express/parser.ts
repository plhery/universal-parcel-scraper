import { load } from 'cheerio';
import { IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, ChallengeError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { etsStage } from './status.js';

export const PROVIDER = 'ETS Express';
export const ETS_ORIGIN = 'http://1.12.55.94:8082';
const OWN_NUMBER = /^RETS\d{12}UES$/;
const IDENTITY_FIELDS = ['business_seqinvoicecode', 'trackingNumber'] as const;
const ETS: HualeiTenant = { carrier: 'ets-express', provider: PROVIDER, origin: ETS_ORIGIN, stage: etsStage, wallClocks: true };
const identity = (value: string): string => value.toUpperCase().replace(/[\s-]+/g, '');

/** Only ETS's own numbers; an Ozon posting is still Ozon's identifier. */
export function normalizeEtsNumber(raw: string): string {
  const number = normalizeHualeiNumber(raw, PROVIDER);
  if (!OWN_NUMBER.test(number)) throw new InvalidInputError(PROVIDER, `${PROVIDER} requires its RETS shipment number`);
  return number;
}

function field(record: JsonObject, key: string): string {
  const value = record[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid ${key}`);
  return value;
}

/**
 * A positive track reply needs the whole RETS invoice or tracking number and a
 * RETS service. The platform also searches other references, which establish
 * neither the shipment identity nor ETS ownership.
 */
export function parseEtsTrack(payload: unknown, raw: string, readAt?: number): CarrierResult | null {
  const number = normalizeEtsNumber(raw);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid envelope`);
  }
  const reply = payload[0];
  if (reply.ack === 'false') {
    const message = field(reply, 'message');
    if (/请求过于频繁|查询过于频繁|操作过于频繁|访问过于频繁|too many requests|rate limit/i.test(message)) {
      throw new RateLimitedError(PROVIDER);
    }
    if (/验证码|安全验证|人机验证|captcha|access denied|request (?:was )?blocked/i.test(message)) {
      throw new ChallengeError(PROVIDER, `${PROVIDER} requires verification`);
    }
    // "No tracks" alone also covers orders without scans. The page settles absence.
    return parseHualeiTrack(payload, number, ETS, readAt);
  }
  if (reply.ack !== 'true' || !Array.isArray(reply.data) || !reply.data.length || reply.data.length > 50) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid record list`);
  }
  const records = reply.data.map((record) => {
    if (!isRecord(record)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid record`);
    return record;
  });
  const bound = records.filter((record) => IDENTITY_FIELDS.some((key) => identity(field(record, key)) === number));
  if (bound.length !== 1) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not identify one matching shipment`);
  const record = bound[0]!;
  if (!/^RETS(?:\s|$)/i.test(field(record, 'productKindName').trim())) {
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not identify its service`);
  }
  const result = parseHualeiTrack([{ ...reply, data: [record] }], number, ETS, readAt)!;
  // Ozon posting references are not canonical ETS numbers or evidence of a delivery handoff.
  delete result.canonical_tracking_number;
  delete result.delivery_tracking_number;
  delete result.delivery_carrier;
  if (!result.events?.[0]?.stage) {
    delete result.current_stage;
    delete result.current_stage_source;
    result.status = 'unknown';
  }
  // The feed states no offset for either a scan or its creation clock.
  for (const event of result.events ?? []) delete event.written_at;
  return result;
}

/**
 * The page's explicit blank waybill settles not-found. Its positive view can
 * show only an Ozon posting while echoing the RETS query, which cannot bind it.
 */
export function parseEtsAbsencePage(html: string, raw: string, readAt?: number): never {
  const number = normalizeEtsNumber(raw);
  try {
    parseHualeiPage(html, number, ETS, readAt);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // Validate the complete fields before any shared display-text truncation.
    const $ = load(html), blocks = $('div.div_canta div.div_cont'), lists = blocks.find('.menu_ ul');
    const headers = lists.eq(0).children('li').toArray().map(node => $(node).text().trim());
    const values = lists.eq(1).children('li').toArray().map(node => $(node).text().trim());
    if (blocks.length !== 1 || lists.length !== 2 || values.length !== 6
      || headers.join('|') !== '参考号|目的地|当地时间|最新状态|收件人|收计费重'
      || identity(values[0]!) !== number || values[1] || values[2] || !['', '/'].includes(values[3]!) || values[4] || values[5]) {
      throw new IndeterminateError(PROVIDER, `${PROVIDER} did not return its empty-waybill signature`);
    }
    throw error;
  }
  throw new IndeterminateError(PROVIDER, `${PROVIDER} did not identify the RETS shipment on its tracking page`);
}
