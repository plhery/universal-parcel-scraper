import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { nanbeiStage, statusMap } from './status.js';

export const PROVIDER = 'Nanbei Express';
export const CARRIER = 'nanbei-express';
// The public example's reply is under 5 kB.
export const NANBEI_MAX_BYTES = 256 * 1024;
// The platform's clocks are epoch instants; the site shows them on China's clock.
const ZONE = 'Asia/Shanghai';

// "21542037706": a waybill, as the site's form takes it.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);
const MAX_SCANS = 300;
// The platform's tenant every public row names: Nanbei Express itself.
const NANBEI_TENANT = '101';

// The platform writes a station's phone into its name, as in "【芜湖分公司--0553-…】".
const MOBILE = String.raw`1[3-9]\d{9}`;
const LANDLINE = String.raw`0\d{2,3}-?\d{7,8}`;
const PHONE = new RegExp(String.raw`(?<![\dA-Za-z])[-–—\s]*(?:${MOBILE}|${LANDLINE})(?!\d)`, 'gu');
// A truck's plate, its driver, a courier or a contact, each in brackets after its label.
const LABELLED = /[，,；;]?\s*(?:车牌号?|驾驶员|司机|派送员|派件员|送货员|快递员|业务员|收件员|签收人|联系人|联系电话|联系方式|电话|手机)[:：]?\s*【[^【】]*】/gu;
// "货物已由【…】签收": the person who signed, left out of "货物已签收".
const SIGNER = /由【[^【】]{1,30}】(代?签收)/gu;
// A phone label left without its number.
const BARE_LABEL = /[，,；;]?\s*(?:联系电话|联系方式|电话|手机)[:：]?\s*(?=$|[，,；;。）)])/gu;

/** A Nanbei Express waybill number, as its tracker takes it. */
export function normalizeNanbeiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Nanbei Express waybill numbers are six to thirty letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** Text without the phone numbers the platform writes into it; the waybill itself stays. */
function withoutPhones(text: string, number: string): string {
  return text.replace(PHONE, (match) => (match.replace(/\D/g, '') === number ? match : ''));
}

/**
 * A row's sentence without the people and phones it names: a station's phone, a truck's plate and
 * driver, and who signed. Station and city names stay.
 */
export function nanbeiWording(sentence: string, number: string): string {
  return withoutPhones(sentence.replace(LABELLED, '').replace(SIGNER, '$1'), number).replace(BARE_LABEL, '')
    .replace(/【\s*】/gu, '').replace(/^[，,；;\s]+|[，,；;\s]+$/gu, '').trim();
}

interface Scan { readonly index: number; readonly millis: number; readonly event: CarrierEvent }

function scan(row: unknown, number: string, index: number): Scan {
  if (!isRecord(row)) return invalid('Nanbei Express returned an invalid row');
  if (normalizeTrackingNumber(cleanScalar(row.eventNo, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Nanbei Express answered about another number');
  }
  // Another tenant's waybill under the same number is not a Nanbei shipment.
  if (row.tenantId !== undefined && row.tenantId !== null && cleanScalar(row.tenantId, 16) !== NANBEI_TENANT) {
    throw new IndeterminateError(PROVIDER, 'Nanbei Express answered with another company\'s waybill');
  }
  const millis = row.eventTime;
  if (typeof millis !== 'number' || !Number.isSafeInteger(millis) || millis < EARLIEST || millis >= LATEST) {
    return invalid('Nanbei Express returned a row without a readable time');
  }
  const code = cleanScalar(row.eventNode, 16);
  const name = clean(row.eventNodeValue, 40);
  const sentence = nanbeiWording(clean(row.eventLog, 600), number).slice(0, 300);
  const description = sentence || name;
  if (!description) return invalid('Nanbei Express returned a row without a wording');
  const location = withoutPhones(clean(row.deptName, 80), number).trim();
  const staged = nanbeiStage(code, name, sentence);
  const time = DateTime.fromMillis(millis, { zone: ZONE }).toISO({ suppressMilliseconds: true })!;
  return { index, millis, event: {
    time, description, ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * Reads the platform's reply for one number: `rows`, oldest first, each the waybill it belongs to,
 * an epoch clock, an event code and name, the sentence the site shows and the branch or sorting
 * centre that recorded it. A number without records gets no rows.
 */
export function parseNanbei(body: string, raw: string): CarrierResult {
  const number = normalizeNanbeiNumber(raw);
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    return invalid('Nanbei Express returned a reply that is not JSON');
  }
  if (!isRecord(reply)) return invalid('Nanbei Express returned an invalid reply');
  if (cleanScalar(reply.code, 16) !== '200') return invalid(`Nanbei Express answered with code ${cleanScalar(reply.code, 16) || 'none'}`);
  const { rows } = reply;
  if (!Array.isArray(rows)) return invalid('Nanbei Express returned a reply without rows');
  if (!rows.length) throw new NotFoundError(PROVIDER, 'Nanbei Express has no shipment under this number');
  if (rows.length > MAX_SCANS) invalid('Nanbei Express returned too many rows');
  const seen = new Set<string>();
  const events = rows.map((row, index) => scan(row, number, index)).filter(({ event }) => {
    const key = JSON.stringify([event.time, event.provider_code, event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.millis - a.millis || b.index - a.index).map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    events,
  };
}
