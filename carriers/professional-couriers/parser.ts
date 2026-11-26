import { load } from 'cheerio';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { professionalCouriersCode, professionalCouriersStage } from './status.js';

export const PROVIDER = 'The Professional Couriers';
export const TPC_ORIGIN = 'https://www.tpcindia.com';
export const TPC_HOME = `${TPC_ORIGIN}/`;
export const TPC_GATE = `${TPC_ORIGIN}/CaptchaGate.aspx`;
export const TPC_TRACK = `${TPC_ORIGIN}/Track-info.aspx`;
const SEARCH = 'ctl00$ctl00$ContentPlaceHolderForTop$ContentPlaceHolderQuickLinkForTop$';
const DETAILS = 'ctl00$ctl00$ContentPlaceHolderMid$ContentPlaceHolder2$';
const ID = 'ContentPlaceHolderMid_ContentPlaceHolder2_';
const MAX_FIELD_LENGTH = 200_000;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Access Denied|Request Rejected/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Consignment numbers are the booking station's three-letter code and eight or nine digits. */
export function normalizeProfessionalCouriersNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!/^[A-Z]{3}\d{8,9}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'TPC consignment numbers are three letters and eight or nine digits');
  }
  return number;
}

function unexpected(html: string, message: string): never {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TPC answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

/** The hidden fields of the page's one form, which every postback sends back. */
function formFields(html: string, message: string): URLSearchParams {
  const $ = load(html);
  const forms = $('form');
  if (forms.length !== 1) unexpected(html, message);
  const fields = new URLSearchParams();
  forms.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (/^__[A-Z]{4,24}$/.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) unexpected(html, message);
  return fields;
}

/** What the home page's consignment search posts, as its search button does. */
export function professionalCouriersSearchFields(html: string, number: string): URLSearchParams {
  if (!html.includes(`name="${SEARCH}TextBox1"`) || !html.includes(`${SEARCH}Button1`)) unexpected(html, 'TPC returned a home page without its consignment search');
  const fields = formFields(html, 'TPC returned a home page without its consignment search');
  fields.set('__EVENTTARGET', `${SEARCH}Button1`);
  fields.set('__EVENTARGUMENT', '');
  fields.set(`${SEARCH}TextBox1`, number);
  return fields;
}

/** True for the home page's answer to a number TPC does not take. */
export function professionalCouriersRefusedNumber(html: string): boolean {
  return /alert\('InValid Consignment No\.'\)/i.test(html);
}

/** The picture the captcha page shows, as a path on the tracker. */
export function professionalCouriersPicture(html: string): string {
  const path = /<img id="imgCaptcha" src="(CaptchaImage\.ashx\?r=[0-9a-f]{8,64})"/.exec(html)?.[1];
  if (!path) unexpected(html, 'TPC returned a captcha page without its picture');
  return `${TPC_ORIGIN}/${path}`;
}

/** What the captcha page posts with a reading. */
export function professionalCouriersCaptchaFields(html: string, answer: string): URLSearchParams {
  if (!html.includes('name="txtCaptcha"') || !html.includes('name="btnVerify"')) unexpected(html, 'TPC returned a captcha page without its form');
  const fields = formFields(html, 'TPC returned a captcha page without its form');
  fields.set('txtCaptcha', answer);
  fields.set('btnVerify', 'Submit');
  return fields;
}

/** True for the captcha page's answer to a wrong reading, which draws a new picture. */
export function professionalCouriersRefusedCaptcha(html: string): boolean {
  return /alert\('Invalid Captcha'\)/.test(html);
}

function headline(html: string): string {
  const match = new RegExp(`<span id="${ID}lbl_track"[^>]*>([^<]{0,600})</span>`).exec(html);
  if (!match) unexpected(html, 'TPC returned a tracking page without its status');
  return clean(match[1], 600);
}

/**
 * Checks the summary the tracker shows first: TPC's answer for a consignment it has no status
 * for, or the status of the consignment asked. Returns the postback that opens its details.
 */
export function professionalCouriersDetailsFields(html: string, raw: string): URLSearchParams {
  const number = normalizeProfessionalCouriersNumber(raw);
  const status = headline(html);
  // The same answer covers a number TPC never booked and one whose records it no longer keeps.
  if (/^We are sorry! Your consignment status request could not be processed\b/.test(status)) throw new NotFoundError(PROVIDER);
  if (!status.startsWith(`${number} `)) throw new SchemaError(PROVIDER, 'TPC returned another consignment');
  if (!html.includes(`${DETAILS}Button8`)) unexpected(html, 'TPC returned a tracking page without its details button');
  const fields = formFields(html, 'TPC returned a tracking page without its form');
  fields.set('__EVENTTARGET', `${DETAILS}Button8`);
  fields.set('__EVENTARGUMENT', '');
  return fields;
}

/**
 * The postback that opens the scans behind TPC's code check, with the code the page prints for
 * every visitor. Null when the page already shows the scans.
 */
export function professionalCouriersVerifyFields(html: string): URLSearchParams | null {
  if (!html.includes(`id="${ID}divVerify"`)) return null;
  const hint = new RegExp(`<div class="tt-verify-hint">([\\s\\S]{0,400}?)</div>`).exec(html)?.[1] ?? '';
  const code = /Enter the 4-digit code\s*<strong>(\d{4})<\/strong>/.exec(hint)?.[1];
  if (!code) throw new ChallengeError(PROVIDER, 'TPC asks for a code its page does not print');
  const fields = formFields(html, 'TPC returned a tracking page without its form');
  fields.set('__EVENTTARGET', `${DETAILS}btnVerify4`);
  fields.set('__EVENTARGUMENT', '');
  fields.set(`${DETAILS}txtLast4`, code);
  return fields;
}

function wallClock(value: string): string | null {
  const match = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{4}) • ([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  const month = match ? MONTHS.indexOf(match[1]!) + 1 : 0;
  const day = match && month ? calendarDay(+match[3]!, month, +match[2]!) : null;
  return day ? `${day}T${match![4]}:${match![5]}:00` : null;
}

/** The consignment's scans, newest first, from the details TPC shows after its code check. */
export function parseProfessionalCouriers(html: string, raw: string): CarrierResult {
  const number = normalizeProfessionalCouriersNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'TPC returned an empty page');
  if (html.includes(`id="${ID}divVerify"`)) throw new ChallengeError(PROVIDER, 'TPC refused the code its page prints');
  const $ = load(html);
  const shown = clean($(`#${ID}lbl_consno`).text(), 40);
  if (!shown) unexpected(html, 'TPC returned a tracking page without its details');
  if (shown !== number) throw new SchemaError(PROVIDER, 'TPC returned another consignment');
  const timeline = $(`#${ID}content`);
  if (timeline.length !== 1) throw new SchemaError(PROVIDER, 'TPC returned details without its scans');
  const rows = timeline.children('div.event');
  if (rows.length !== timeline.find('div.event').length || rows.length > 500) throw new SchemaError(PROVIDER, 'TPC returned an invalid scan');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  const events: CarrierEvent[] = [], seen = new Set<string>();
  rows.each((index, row) => {
    const clock = wallClock(clean($(row).find('.tt-event-date').text(), 40));
    const description = clean($(row).find(`[id="${ID}ListViewName_lnkActivty_${index}"]`).text(), 300);
    const from = clean($(row).find(`[id="${ID}ListViewName_lbl1_${index}"]`).text(), 80);
    if (!clock || !description) throw new SchemaError(PROVIDER, 'TPC returned an invalid scan');
    const code = professionalCouriersCode(description);
    // A scan's "From" is the station that sent the consignment on; a receipt names the station
    // that received it, before the hyphen that adds its branch.
    const place = (code === 'Received at' ? /^Received at ([^-]{2,60}?)(?:-|$)/i.exec(description)?.[1]?.trim() : undefined) || from;
    const stage = code ? professionalCouriersStage(code) : undefined;
    const event: CarrierEvent = { local_time: clock, description, ...(code ? { provider_code: code } : {}),
      ...(place ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  });
  // The page lists scans newest first; a stable sort keeps its order within a minute.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 200) };
}
