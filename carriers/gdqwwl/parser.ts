import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { quanwangStage, statusMap } from './status.js';

export const PROVIDER = 'Quanwang Logistics';
export const CARRIER = 'gdqwwl';
/** The firm's WeChat tracker, on plain HTTP and port 8080. */
export const QUANWANG_ORIGIN = 'http://wx.gdqwwl.com:8080';
/** The tracker's form: the number, and a name or phone it does not need. */
export const QUANWANG_FORM = `${QUANWANG_ORIGIN}/XBM_RootDir/TPL_Base/FORM_99_5.bsp`;
/** Where the form posts. */
export const QUANWANG_SERVICE = `${QUANWANG_ORIGIN}/XBM_RootDir/TPL_Base/XBM_Service.bsp?EXEC`;
// The form is 2 kB and a waybill's page about 10 kB.
export const QUANWANG_PAGE_MAX_BYTES = 256 * 1024;

// "190423000281": the date and a serial; a hand-written waybill's number is shorter.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,20}$/;
// "%(pBd9SZS47y8vB4gZ3TDquuVR)": the opaque references the form posts back as they are.
const REFERENCE = String.raw`%\([A-Za-z0-9_]{4,80}\)`;
const VIEW_STATE = new RegExp(String.raw`<input\b[^>]*\bname="ViewState"[^>]*\bvalue="(${REFERENCE})"`);
const ACTION = new RegExp(String.raw`<input\b[^>]*\bname="Action"[^>]*\bvalue="(${REFERENCE}(?:;${REFERENCE})*)"`);
const SUBMIT = new RegExp(String.raw`SubmitExec\('(${REFERENCE})'\)`);
const RESULT_TITLE = '<title>网上单票_查货</title>';
const ROW = /<tr onmousedown="OnRowSelector\(this\)">([\s\S]*?)<\/tr>/g;
const CELL = /<td class="celler">([\s\S]*?)<\/td>/g;
// "2019-04-23 14:12:06": the row's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// The person a row names after their role, "签收人：…", which the result leaves out.
const PERSON = /[，,]?\s*(?:签收人|收货人|收件人|经办人|司机|派送员|送货员)\s*[:：]\s*[^，,。；;\s]{1,20}/gu;
// A mobile or a landline with its area code.
const PHONE = /(?<!\d)(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?!\d)/gu;
// "货物已到达嘉兴市": the city the freight reached.
const ARRIVED = /^货物已到达(.{1,20})$/u;
const MAX_ROWS = 300;

/** A Quanwang waybill number, as its tracker takes it. */
export function normalizeQuanwangNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Quanwang waybill numbers are six to twenty letters and digits');
  return number;
}

/** The references the tracker's form posts back with the number. */
export interface QuanwangForm {
  readonly viewState: string;
  readonly action: string;
  readonly source: string;
}

/** Reads the tracker's form for the references its button posts. */
export function parseQuanwangForm(html: string): QuanwangForm {
  const viewState = VIEW_STATE.exec(html)?.[1];
  const action = ACTION.exec(html)?.[1];
  const source = SUBMIT.exec(html)?.[1];
  if (!viewState || !action || !source || !html.includes('name="TB_FS_BG_Code"')) {
    throw new SchemaError(PROVIDER, 'Quanwang returned a tracking form without the fields it posts');
  }
  return { viewState, action, source };
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

const decode = (value: string) => value.replace(/&#(\d{1,6});/g, (_, code: string) => String.fromCodePoint(Number(code)));

/** The value of the read-only field the page labels `name`, or '' when the page leaves it empty. */
function field(html: string, name: string): string | undefined {
  const input = new RegExp(String.raw`<input\b[^>]*\bxname="${name}"[^>]*>`).exec(html)?.[0];
  if (!input) return undefined;
  return textFromHtml(decode(/\bvalue="([^"]*)"/.exec(input)?.[1] ?? ''), 80);
}

/** A row's wording without the people and phone numbers it may name. */
function wordingOf(text: string): string {
  return text.replace(PERSON, '').replace(PHONE, '').replace(/[，,：:\s]+$/u, '').trim();
}

/**
 * Reads the tracker's page for one number: the waybill's fields, then its rows oldest first, each a wall clock
 * without a zone and a Chinese wording beside the handler, plate, driver, phone and remark, which are not read.
 * A number the system holds nothing for gets the same page with every field empty and no rows.
 */
export function parseQuanwang(html: string, raw: string): CarrierResult {
  const number = normalizeQuanwangNumber(raw);
  if (!html.includes(RESULT_TITLE)) return invalid('Quanwang returned a page other than its waybill page');
  const waybill = field(html, '运单编号');
  const manual = field(html, '手工单号');
  if (waybill === undefined || manual === undefined) return invalid('Quanwang returned a waybill page without its number fields');
  const rows = [...html.matchAll(ROW)].map((match) => [...match[1]!.matchAll(CELL)].map((cell) => textFromHtml(decode(cell[1]!), 400)));
  if (!waybill && !manual) {
    if (rows.length) return invalid('Quanwang returned rows without a waybill');
    throw new NotFoundError(PROVIDER, 'Quanwang has no waybill under this number');
  }
  if (normalizeTrackingNumber(waybill) !== number && normalizeTrackingNumber(manual) !== number) {
    throw new IndeterminateError(PROVIDER, 'Quanwang answered about another number');
  }
  if (rows.length > MAX_ROWS) return invalid('Quanwang returned too many rows');
  const seen = new Set<string>();
  const events = rows.map((cells, index) => {
    if (cells.length < 3) return invalid('Quanwang returned a row without its time and wording');
    const clock = CLOCK.exec(cells[1]!);
    const day = clock ? calendarDay(Number(clock[1]), Number(clock[2]), Number(clock[3])) : null;
    if (!clock || !day) return invalid('Quanwang returned a row without a readable time');
    const description = wordingOf(cells[2]!).slice(0, 300);
    if (!description) return invalid('Quanwang returned a row without a wording');
    const location = ARRIVED.exec(description)?.[1];
    const staged = quanwangStage(description);
    const event: CarrierEvent & { local_time: string } = {
      local_time: `${day}T${clock[4]}:${clock[5]}:${clock[6] ?? '00'}`, description,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { index, event };
  }).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index).map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Quanwang holds the waybill without any rows');
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    destination_country: 'CN',
    events,
  };
}
