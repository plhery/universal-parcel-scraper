import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { yuxinStage } from './status.js';

export const PROVIDER = 'Yuxin Logistics';
// The tracker answers on plain HTTP only.
export const YUXIN_ORIGIN = 'http://www.yx56.cn';
export const YUXIN_PAGE = `${YUXIN_ORIGIN}/ix/list-5beacd23b8e445e28bd2d905eec2e56a.html`;
export const YUXIN_CAPTCHA = `${YUXIN_ORIGIN}/servlet/validateCodeServlet`;
export const YUXIN_ENDPOINT = `${YUXIN_ORIGIN}/ix/cms/tFlow/queryExpressOrders`;
export const YUXIN_REFUSED = 'Yuxin Logistics refused the captcha answer';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|安全验证|访问受限|访问被拒绝)/i;

/** The page's own check says a waybill is ten digits. */
export function normalizeYuxinNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Yuxin Logistics waybills are ten digits');
  return number;
}

export function yuxinJson(text: string): unknown {
  if (/^\s*</.test(text)) {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Yuxin Logistics answered with a browser check');
    throw new SchemaError(PROVIDER, 'Yuxin Logistics returned a page instead of its tracking reply');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new SchemaError(PROVIDER, 'Yuxin Logistics returned a reply that is not JSON'); }
}

const text = (value: unknown): string => (typeof value === 'string' ? clean(value, 80) : '');

function clock(raw: unknown): string {
  const match = typeof raw === 'string' && /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(raw.trim());
  const day = match && calendarDay(+match[1]!, +match[2]!, +match[3]!);
  if (!match || !day) throw new SchemaError(PROVIDER, 'Yuxin Logistics returned an invalid scan clock');
  return `${day}T${match[4]}`;
}

/**
 * A scan's wording as the tracker's page writes it from the scan's type and the branches it
 * names. The staff member who scanned it is left out.
 */
function wording(flow: Record<string, unknown>, latest: boolean, signed: boolean): { description: string; location: string } {
  const name = text(flow.operateTypeName), owner = text(flow.ownerName), next = text(flow.nextOwnerName);
  if (flow.status === 1) return { description: `${name}【${owner}】`, location: owner };
  if (flow.operateType === 4) {
    // The page adds whether every piece arrived only to the newest scan of an unsigned waybill.
    const pieces = latest && !signed && flow.isArrive === 0 && text(flow.isAllArrive) ? `【${text(flow.isAllArrive)}】` : '';
    return { description: `已到达【${next}】${pieces}`, location: next };
  }
  if (flow.operateType === 0) return { description: `${name}【${owner}】下一站【${next}】`, location: owner };
  return { description: `${name}【${owner}】发往【${next}】`, location: owner };
}

export function parseYuxin(payload: unknown, raw: string): CarrierResult {
  const number = normalizeYuxinNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Yuxin Logistics returned no tracking envelope');
  if (payload.status !== 200) {
    const message = text(payload.msg);
    if (/验证码/.test(message)) throw new ChallengeError(PROVIDER, YUXIN_REFUSED);
    if (/太快|频繁/.test(message)) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Yuxin Logistics did not complete the lookup');
  }
  let data: unknown;
  try { data = typeof payload.data === 'string' ? JSON.parse(payload.data) as unknown : undefined; }
  catch { throw new SchemaError(PROVIDER, 'Yuxin Logistics returned waybills that are not JSON'); }
  if (!isRecord(data) || Object.keys(data).length !== 1 || !isRecord(data[number])) throw new SchemaError(PROVIDER, 'Yuxin Logistics returned another waybill');
  const waybill = data[number];
  const order = isRecord(waybill.orders) ? waybill.orders : undefined;
  if (order && order.orderId !== number) throw new SchemaError(PROVIDER, 'Yuxin Logistics returned another waybill');
  if (!Array.isArray(waybill.flows) || waybill.flows.length > 500) throw new SchemaError(PROVIDER, 'Yuxin Logistics returned an invalid scan list');
  // The tracker answers a waybill it does not hold with an empty scan list and no order.
  if (!waybill.flows.length) {
    if (order) throw new NoHistoryError(PROVIDER);
    throw new NotFoundError(PROVIDER);
  }
  const signed = order?.orderStatus === '3';
  const events: CarrierEvent[] = [], seen = new Set<string>();
  waybill.flows.forEach((flow, index) => {
    if (!isRecord(flow) || flow.orderId !== number || !Number.isInteger(flow.operateType) || !text(flow.operateTypeName)) {
      throw new SchemaError(PROVIDER, 'Yuxin Logistics returned an invalid scan');
    }
    const type = text(flow.operateTypeName), stage = yuxinStage(type);
    const { description, location } = wording(flow, index === 0, signed);
    const event: CarrierEvent = { local_time: clock(flow.operateDate), provider_code: type, description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  });
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof yuxinStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 200) };
}
