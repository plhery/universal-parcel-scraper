import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { omgExpressCodeStage, statusMap } from './status.js';

export const PROVIDER = 'OMG Express';
export const CARRIER = 'omg-express';
// The public example's page is about 33 kB; a long timeline stays well under this.
export const OMG_EXPRESS_MAX_BYTES = 1024 * 1024;

// "OMG2508291001": OMG and the waybill's digits. The tracker also takes a recipient's phone
// number, and a five-digit or OMG-and-four-digit customer code behind a login; neither is taken.
const NUMBER = /^OMG\d{8,12}$/;
// The page's server data, which Next.js streams into the page as script calls.
const FLIGHT = /<script>self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
// "2025-09-14 17:45:05": the scan's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const CODE = /^[A-Z][A-Z_]{1,40}$/;
const NOT_FOUND = '没有查询到这个运单';
// A Chinese courier's scans name the courier with a mobile number, give its station's and its
// complaint line's numbers, and add a notice that names them: all are left out.
const MOBILE = String.raw`1[3-9]\d{9}`;
const LANDLINE = String.raw`0\d{2,3}-?\d{7,8}`;
const CONTACT = new RegExp(String.raw`由?【[^【】]{0,20}?(?:${MOBILE}|${LANDLINE})[^【】]{0,10}】`, 'gu');
const NOTICE = /[（(][^（）()]*\d{5,}[^（）()]*[）)]/gu;
const PHONE = new RegExp(String.raw`${MOBILE}|${LANDLINE}|(?<!\d)95\d{3,4}(?!\d)`, 'u');
const MAX_SCANS = 300;
const MAX_CHUNKS = 200;

/** An OMG Express waybill number, as the tracker's address takes it. */
export function normalizeOmgExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'OMG Express waybill numbers are OMG and eight to twelve digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The records of the page's server data, with the component each `$L` reference names. */
function flightOf(html: string): { records: unknown[]; modules: Map<string, string> } {
  const chunks: string[] = [];
  for (const match of html.matchAll(FLIGHT)) {
    let value: unknown;
    try { value = JSON.parse(match[1]!); } catch (error) { throw new SchemaError(PROVIDER, 'OMG Express returned invalid server data', { cause: error }); }
    if (Array.isArray(value) && value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1]);
    if (chunks.length > MAX_CHUNKS) invalid('OMG Express returned too much server data');
  }
  const modules = new Map<string, string>();
  const records: unknown[] = [];
  for (const line of chunks.join('').split('\n')) {
    const imported = /^([0-9a-f]+):I(\[.*\])$/.exec(line);
    if (imported) {
      try {
        const value: unknown = JSON.parse(imported[2]!);
        if (Array.isArray(value) && typeof value.at(-1) === 'string') modules.set(`$L${imported[1]}`, value.at(-1) as string);
      } catch (error) { throw new SchemaError(PROVIDER, 'OMG Express returned invalid component data', { cause: error }); }
      continue;
    }
    const model = /^[0-9a-f]+:([[{].*)$/.exec(line);
    if (!model) continue;
    try { records.push(JSON.parse(model[1]!) as unknown); } catch (error) {
      throw new SchemaError(PROVIDER, 'OMG Express returned invalid page data', { cause: error });
    }
  }
  return { records, modules };
}

interface Page { routed: string[]; looked: string[]; events: unknown[] | undefined; missing: boolean; partner?: string }

/** What the page's records say: the number its address asked, the timeline, and the not-found answer. */
function pageOf(html: string): Page {
  const { records, modules } = flightOf(html);
  const page: Page = { routed: [], looked: [], events: undefined, missing: false };
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 200 || node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      // The router's segment for the address, ["trackingNumber", "<number>", "d", ...].
      if (node[0] === 'trackingNumber' && typeof node[1] === 'string') page.routed.push(node[1]);
      // An element, ["$", "<type or $L reference>", key, props].
      if (node[0] === '$' && typeof node[1] === 'string' && isRecord(node[3])) {
        const component = modules.get(node[1]);
        const props = node[3];
        if (component === 'TrackingTimeline' && Array.isArray(props.events)) page.events = props.events;
        if (component === 'PublicQueryRefreshProgress' && Array.isArray(props.visibleTrackingNumbers)) {
          page.looked.push(...props.visibleTrackingNumbers.filter((value): value is string => typeof value === 'string'));
        }
        if (props.children === NOT_FOUND) page.missing = true;
      }
      // The line under the number: ["国内快递：" label, courier, " ", courier's number].
      const labelled = node.findIndex((item) => Array.isArray(item) && item[0] === '$' && isRecord(item[3]) && item[3].children === '国内快递：');
      if (labelled >= 0) {
        const onward = node.slice(labelled + 1).filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
        const reference = normalizeTrackingNumber(onward.at(-1) ?? '');
        if (/^[A-Z0-9]{6,30}$/.test(reference)) page.partner = reference;
      }
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  for (const record of records) visit(record, 0);
  return page;
}

/** A scan's wording without the courier's name and phone numbers, or the notices that list numbers. */
export function withoutContacts(text: string): string {
  const kept = text.replace(CONTACT, '').replace(NOTICE, '')
    .split(/(?<=[。！!])/u).filter((clause) => !PHONE.test(clause) && !clause.includes('无需找商家')).join('');
  return kept.replace(/\s+/g, ' ').trim();
}

function scanOf(value: unknown, index: number): { index: number; event: CarrierEvent & { local_time: string } } {
  if (!isRecord(value)) return invalid('OMG Express returned an invalid scan');
  const clock = typeof value.eventTime === 'string' ? CLOCK.exec(value.eventTime.trim()) : null;
  const day = clock ? calendarDay(Number(clock[1]), Number(clock[2]), Number(clock[3])) : null;
  if (!clock || !day) return invalid('OMG Express returned a scan without a readable time');
  const code = typeof value.status === 'string' && CODE.test(value.status) ? value.status : undefined;
  const label = typeof value.statusText === 'string' ? value.statusText.trim().slice(0, 40) : '';
  const description = (typeof value.description === 'string' ? withoutContacts(value.description) : '').slice(0, 300) || label;
  if (!description) return invalid('OMG Express returned a scan without a wording');
  const location = typeof value.location === 'string' ? value.location.trim().slice(0, 80) : '';
  const stage = code ? omgExpressCodeStage(code) : undefined;
  return { index, event: {
    local_time: `${day}T${clock[4]}:${clock[5]}:${clock[6] ?? '00'}`, description,
    ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/**
 * Reads the tracking page for one number: the timeline's scans, each on the wall clock the page
 * gives without a zone, with a status code and a Chinese wording. The page answers an unknown
 * number with one sentence, and names the number it was asked only in its address.
 */
export function parseOmgExpress(html: string, raw: string): CarrierResult {
  const number = normalizeOmgExpressNumber(raw);
  const page = pageOf(html);
  const routed = page.routed.map((value) => normalizeTrackingNumber(value));
  if (!routed.length) return invalid('OMG Express returned a page without the number it was asked');
  if (!routed.every((value) => value === number)) throw new IndeterminateError(PROVIDER, 'OMG Express answered about another number');
  if (page.missing && !page.events) throw new NotFoundError(PROVIDER, 'OMG Express has no waybill under this number');
  if (!page.events) return invalid('OMG Express returned neither a timeline nor its not-found answer');
  if (!page.looked.map((value) => normalizeTrackingNumber(value)).includes(number)) {
    throw new IndeterminateError(PROVIDER, 'OMG Express showed a timeline for another waybill');
  }
  if (page.events.length > MAX_SCANS) invalid('OMG Express returned too many scans');
  const seen = new Set<string>();
  const events = page.events.map(scanOf).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.provider_code ?? '', event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index).map(({ event }) => event);
  if (!events.length) return invalid('OMG Express returned a waybill without scans');
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    ...(latest.provider_code ? { provider_code: latest.provider_code } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    destination_country: 'CN',
    ...(page.partner && page.partner !== number ? { delivery_tracking_number: page.partner } : {}),
    events,
  };
}
