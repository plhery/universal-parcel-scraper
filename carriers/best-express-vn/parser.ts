import { ChallengeError, IndeterminateError, InputRequiredError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochMillisTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bestStage } from './status.js';

/**
 * One country's BEST tracker: its address, the key BEST's verification service knows it by, which
 * its page gives every visitor, the language its scans are asked in, its clock and the wording of
 * a signature.
 */
export interface BestRegion {
  readonly carrier: string;
  readonly provider: string;
  readonly site: string;
  readonly appKey: string;
  readonly language: Readonly<Record<string, string>>;
  readonly timezone: string;
  readonly signer: RegExp;
}

export const BEST_VN: BestRegion = {
  carrier: 'best-express-vn', provider: 'BEST Express Vietnam', site: 'https://www.best-inc.vn',
  appKey: 'ef49c150db25a98c410bae455cc3ec79', // gitleaks:allow
  language: { 'X-Nat': 'vi-VN', 'lang-type': 'vi-VN', 'X-Lan': 'VI' },
  timezone: 'Asia/Ho_Chi_Minh', signer: /^(\S.*?)\s+Ký nhận$/u,
};

const MAX_EVENTS = 200;
// The gateway's answer when it wants a fresh picture verification before it looks the number up.
const RISK = 'risk_001';
// The courier who collects or delivers, with their phone, as "【name/0912345678】".
const COURIER = /【[^【】]*\/[^【】]*】/gu;
// Any other run of nine or more digits, as a phone number is written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// The scan's site, after its district, at the head of the wording: "Quận 12【FS TÂN THỚI NHẤT】,".
const HEAD = /^([^【】,，]*)【([^【】]+)】\s*[,，]\s*/u;
// The site that ends an arrival's wording: "Đến nơi Củ Chi【HCM HUB】".
const TAIL = /【([^【】]+)】$/u;

/** The refusal a lookup gets when the gateway wants a new picture answered first. */
export const refusedVerification = (region: BestRegion) => `${region.provider} refused the picture verification`;

/** A waybill or another reference of letters and digits the tracker reads. */
export function isBestNumber(number: string): boolean {
  return /^[A-Z0-9]{8,30}$/.test(number);
}

/** A scan's wording without its courier and its place, and the place: the site, then its district. */
function wordingOf(remark: string, district: string): { description: string; site: string; bare: string } {
  const bare = remark.replace(COURIER, '').replace(PHONE, '').replace(/\s+/g, ' ').trim();
  let text = bare, site = '';
  const head = HEAD.exec(text);
  if (head) {
    site = clean(head[2], 120);
    text = text.slice(head[0].length);
  } else {
    const tail = TAIL.exec(text);
    const before = tail ? text.slice(0, tail.index).trimEnd() : '';
    if (tail && district && before.endsWith(district)) {
      site = clean(tail[1], 120);
      text = `${before.slice(0, -district.length).trimEnd()} ${site}`;
    }
  }
  const description = text.replace(/【([^【】]*)】/gu, ' $1 ').replace(/\s+/g, ' ')
    .replace(/\s+([,，.])/g, '$1').replace(/^[\s,，]+|[\s,，]+$/g, '');
  return { description, site, bare };
}

interface Scan { event: CarrierEvent & { time: string; description: string }; signer?: string }

function scanOf(value: unknown, region: BestRegion): Scan {
  const { provider } = region;
  if (!isRecord(value)) throw new SchemaError(provider, `${provider} returned an unreadable scan`);
  const remark = clean(value.remark, 600).normalize('NFC');
  const time = epochMillisTime(value.acceptTime);
  if (!remark || !time) throw new SchemaError(provider, `${provider} returned an unreadable scan`);
  const district = clean(value.acceptAddress, 120).normalize('NFC');
  const { description, site, bare } = wordingOf(remark, district);
  if (!description) throw new SchemaError(provider, `${provider} returned an unreadable scan`);
  const location = [...new Set([site, district].filter(Boolean))].join(', ');
  const code = cleanScalar(value.scanTypeCode, 8);
  const classified = bestStage(code, description);
  const signer = code === '17' || classified?.stage === 'delivered' ? region.signer.exec(description)?.[1] : undefined;
  return {
    event: { time: time.iso, description, ...(description !== bare ? { original_description: bare } : {}),
      ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) },
    ...(signer ? { signer: clean(signer, 120) } : {}),
  };
}

/**
 * The tracker's reply for one waybill: its scans oldest first in `traceDetails`, the sender and
 * recipient in `expressUser`. A waybill listed in `notMatchCodeList` is shown only with digits of
 * the recipient's phone.
 */
export function parseBest(payload: unknown, number: string, region: BestRegion): CarrierResult {
  const { provider } = region;
  if (!isRecord(payload)) throw new SchemaError(provider, `${provider} returned an unreadable reply`);
  if (payload.success !== true) {
    if (payload.errorCode === RISK) throw new ChallengeError(provider, refusedVerification(region));
    throw new IndeterminateError(provider, `${provider} did not answer for the waybill`);
  }
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.expressList)) throw new SchemaError(provider, `${provider} returned an unreadable reply`);
  if (Array.isArray(data.notMatchCodeList) && data.notMatchCodeList.some(code => cleanScalar(code, 40).toUpperCase() === number)) {
    throw new InputRequiredError(provider, 'recipient verification', `${provider} shows this waybill only with digits of the recipient’s phone`);
  }
  const list: unknown[] = data.expressList;
  const entry = list.find(item => isRecord(item) && cleanScalar(item.expressId, 40).toUpperCase() === number);
  if (!isRecord(entry)) {
    if (!list.length) throw new NotFoundError(provider);
    throw new SchemaError(provider, `${provider} answered for another waybill`);
  }
  const details = entry.traceDetails;
  if (details !== null && details !== undefined && !Array.isArray(details)) throw new SchemaError(provider, `${provider} returned an unreadable history`);
  if (!details?.length) throw new NotFoundError(provider);
  if (details.length > MAX_EVENTS) throw new SchemaError(provider, `${provider} returned an excessive history`);
  const scans = details.map(item => scanOf(item, region)).reverse();
  const events = scans.map(scan => scan.event);
  const newest = events[0]!;
  const staged = events.find(event => event.stage);
  const signer = staged?.stage === 'delivered' ? scans.find(scan => scan.event === staged)?.signer : undefined;
  const people = isRecord(entry.expressUser) ? entry.expressUser : {};
  const sender = clean(people.senderName, 200).normalize('NFC');
  const receiver = clean(people.addresseeName, 200).normalize('NFC');
  const province = clean(people.addresseeProvName, 120).normalize('NFC');
  return {
    status: staged ? languageStageStatus(staged.stage as Stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: newest.description, last_update: newest.time, expected_delivery: null,
    ...(staged?.stage === 'delivered' ? { delivered_at: staged.time } : {}),
    ...(sender ? { sender_name: sender } : {}), ...(receiver ? { receiver_name: receiver } : {}),
    ...(province ? { receiver_address: province } : {}), ...(signer ? { signed_by: signer } : {}),
    timezone: region.timezone, events,
  };
}
