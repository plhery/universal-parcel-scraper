import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { scanStatusMap } from './status.js';

export const PROVIDER = 'Chinz Logistics';
const NO_HISTORY = '轨迹记录没找到！';

export function chinzNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Chinz Logistics needs a single order number');
  return number;
}

function scan(row: unknown): { event: CarrierEvent; at: number } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Chinz Logistics returned an invalid scan');
  const orderStatus = row.order_status;
  const partner = orderStatus === -1;
  const code = partner ? clean(row.info_status, 48) : Number.isSafeInteger(orderStatus) ? String(orderStatus) : '';
  const clock = zonedTime(row.created_at, 'yyyy-MM-dd HH:mm:ss', 'UTC');
  const message = textFromHtml(row.message);
  if (!clock || !message || !code) throw new SchemaError(PROVIDER, 'Chinz Logistics returned an incomplete scan');

  // The partner rows can include the driver's contact details after the update or next to the station.
  const description = partner ? message.split(/[，,](?:揽收人|签收人)\s*[：:]|[（(]有事先|如有疑问/)[0]!
    .replace(/】的[^（(]{1,25}[（(][+\d -]{7,25}[）)]/g, '】')
    .replace(/(?<!\d)(?:1[3-9]\d{9}|0\d{2,3}-\d{7,8})(?!\d)/g, '').trim() : message;
  const location = partner ? /【([^】]+)】/.exec(message)?.[1] : clean(row.server_point, 120);
  const stage = scanStatusMap.stage(code, description);
  return {
    at: clock.timestamp,
    event: {
      local_time: clock.iso.slice(0, 19), description, provider_code: code,
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    },
  };
}

export function parseChinz(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Chinz Logistics returned an invalid envelope');
  if (payload.status !== 200) {
    const message = clean(payload.message);
    if (payload.status === 429 || /频繁|限流|rate limit/i.test(message)) throw new RateLimitedError(PROVIDER);
    if (/验证码|captcha|verification/i.test(message)) throw new ChallengeError(PROVIDER);
    if (payload.status === 400 && payload.data === '' && message === NO_HISTORY) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Chinz Logistics did not complete the lookup');
  }
  const order: unknown = Array.isArray(payload.data) && payload.data.length === 1 ? (payload.data as unknown[])[0] : null;
  if (!isRecord(order) || typeof order.order_sn !== 'string' || order.order_sn.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Chinz Logistics did not identify the requested order');
  }

  const history = order.logicinfo;
  if (!Array.isArray(history) || history.length > 1000) throw new SchemaError(PROVIDER, 'Chinz Logistics returned an unreadable history');
  if (history.length === 0) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  const seen = new Set<string>();
  const events = history.map(scan).reverse().sort((left, right) => right.at - left.at).map(({ event }) => event)
    .filter(event => {
      const key = JSON.stringify([event.local_time, event.provider_code, event.description, event.location]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const stage = leadingScan(events, scanStatusMap)?.stage as Stage | undefined;
  const newest = events[0]!;
  const extraParcels = isRecord(order.trackparcels) ? Object.keys(order.trackparcels).length > 0
    : Array.isArray(order.trackparcels) && order.trackparcels.length > 0;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, 100),
    ...(events.length > 100 || extraParcels ? { history_truncated: true } : {}),
  };
}
