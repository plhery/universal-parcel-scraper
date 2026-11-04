import { isJunfengInternationalReference } from '../../core/detection/junfengInternational.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { junfengInternationalGap, junfengInternationalStage } from './status.js';

export const PROVIDER = 'JunFeng International';
export const JUNFENG_ENDPOINT = 'https://www.junfengfast.com/api/public/tracking';

export function normalizeJunfengInternationalNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'JunFeng needs a shipment reference');
  if (!isJunfengInternationalReference(number)) throw new NoHistoryError(PROVIDER, 'The international guest lookup needs a valid postal reference', { reason: 'unsupported_reference' });
  return number;
}

function clock(value: unknown): string {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(value);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) throw new SchemaError(PROVIDER, 'JunFeng returned an invalid scan clock');
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
}

export function parseJunfengInternational(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJunfengInternationalNumber(raw);
  if (!isRecord(payload) || typeof payload.resultCode !== 'string') throw new SchemaError(PROVIDER, 'JunFeng returned no tracking envelope');
  if (payload.resultCode !== '0') {
    const message = typeof payload.resultMsg === 'string' ? payload.resultMsg.slice(0, 1000) : '';
    if (/rate limit|too many requests|频繁/i.test(message)) throw new RateLimitedError(PROVIDER);
    if (/captcha|verification|blocked|验证码/i.test(message)) throw new ChallengeError(PROVIDER, 'JunFeng requires verification');
    throw new IndeterminateError(PROVIDER, 'JunFeng did not complete the lookup');
  }
  const wrapper = isRecord(payload.data) && isRecord(payload.data.TrackInfo) ? payload.data.TrackInfo.Data : undefined;
  if (!isRecord(wrapper) || wrapper.Result !== '0' || !Array.isArray(wrapper.dataList) || wrapper.dataList.length !== 1) {
    throw new SchemaError(PROVIDER, 'JunFeng returned no unique tracking record');
  }
  const record: unknown = wrapper.dataList[0];
  if (!isRecord(record) || typeof record.outwaybillCode !== 'string' || record.outwaybillCode.length > 64
    || normalizeTrackingNumber(record.outwaybillCode) !== number || !isRecord(record.Data)) throw new SchemaError(PROVIDER, 'JunFeng returned another shipment');
  const data = record.Data;
  if (!Array.isArray(data.Destination) || data.Destination.length > 500
    || (data.TheSenderTo !== undefined && (!Array.isArray(data.TheSenderTo) || data.TheSenderTo.length))) {
    throw new SchemaError(PROVIDER, 'JunFeng changed its international history');
  }
  if (data.Result === '-1' && !data.Destination.length && record.LatestStatus === null) {
    throw new NoHistoryError(PROVIDER, 'JunFeng has no available history', { reason: 'portal_not_found' });
  }
  if (data.Result !== '0' || typeof record.LatestStatus !== 'string' || record.LatestStatus.length > 1000) throw new SchemaError(PROVIDER, 'JunFeng returned an incomplete history');
  if (!data.Destination.length) throw new NoHistoryError(PROVIDER, 'JunFeng returned no dated history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  let ownLeg = false, newestWording = '';
  for (const [index, row] of data.Destination.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'JunFeng returned an invalid scan');
    const value = row.Details ?? row.StatusDescription;
    if (typeof value !== 'string' || !value.trim() || value.length > 2000
      || (row.Details != null && row.StatusDescription != null && row.Details !== row.StatusDescription)) {
      throw new SchemaError(PROVIDER, 'JunFeng returned an invalid scan activity');
    }
    const wording = clean(value);
    if (index === 0) newestWording = wording;
    ownLeg ||= wording === '航司已收货，等待装板' || wording === '已发货，司机正在送到机场';
    const description = wording.split(/https?:\/\/|(?:recipient|phone|签收人|电话)\s*[:：]/i, 1)[0]!.trim();
    if (!description) throw new SchemaError(PROVIDER, 'JunFeng returned no logistics activity');
    const facility = /^([^,]{1,150}\bPFW (?:Depot|National Hub)), /.exec(description)?.[1];
    const stage = junfengInternationalStage(description);
    const event: CarrierEvent = { local_time: clock(row.Date), description,
      ...(facility ? { location: facility } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!ownLeg) throw new IndeterminateError(PROVIDER, 'JunFeng did not show its own forwarding leg', { reason: 'unsupported_service' });
  if (normalizeStatusWording(record.LatestStatus) !== normalizeStatusWording(newestWording)) throw new SchemaError(PROVIDER, 'JunFeng returned a contradictory current status');
  const newest = events[0]!;
  let stage = junfengInternationalStage(newest.description!);
  // A dated schedule can retain prior progress, but never an earlier closing outcome.
  if (!stage && junfengInternationalGap(newest.description!)) {
    const previous = events.find(event => event.stage)?.stage;
    if (previous === 'registered' || previous === 'in_transit' || previous === 'customs' || previous === 'exception') stage = previous;
  }
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
