import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { directFreightStage } from './status.js';

export const PROVIDER = 'Direct Freight Express';
export const DIRECT_FREIGHT_MAX_BYTES = 512 * 1024;
const BLOCKED = /_cf_chl_opt|cf-chl-|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|Incapsula incident|Request unsuccessful|verify (?:that )?you are human|403 Forbidden/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A lookup constraint, not evidence that a shared numeric layout belongs to this network. */
export function normalizeDirectFreightNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{13}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Direct Freight needs its thirteen-digit consignment number');
  return number;
}

function clock(value: string): string {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(value);
  const day = m ? calendarDay(Number(m[3]), MONTHS.indexOf(m[2]!) + 1, Number(m[1])) : null;
  if (!m || !day) throw new SchemaError(PROVIDER, 'Direct Freight returned an invalid scan clock');
  return `${day}T${m[4]}`;
}

export function parseDirectFreight(html: string, raw: string): CarrierResult {
  const number = normalizeDirectFreightNumber(raw);
  if (new TextEncoder().encode(html).byteLength > DIRECT_FREIGHT_MAX_BYTES) throw new SchemaError(PROVIDER, 'Direct Freight returned an oversized page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'Direct Freight returned browser verification');
  const $ = load(html), form = $('form#frmConsignmentStatus');
  if (form.length !== 1) throw new SchemaError(PROVIDER, 'Direct Freight returned no unique tracking form');
  const messages = form.find('#lblMessage');
  if (messages.length !== 1 || messages.text().length > 1000) throw new SchemaError(PROVIDER, 'Direct Freight changed its lookup notice');
  const message = clean(messages.text(), 1000), panel = form.find('#pnlSingleConcharge'), history = panel.children('#pnlManifestTracking');
  if (message) {
    const missing = /^Consignment Number (\d{13}) could not be found\. Please try again!$/.exec(message);
    if (!missing || missing[1] !== number || panel.length || form.find('#lblConnote, #pnlManifestTracking').length) {
      throw new IndeterminateError(PROVIDER, 'Direct Freight returned an inconclusive lookup notice');
    }
    // The portal does not distinguish an expired consignment from an unknown one.
    throw new NoHistoryError(PROVIDER, 'Direct Freight has no available history for this consignment', { reason: 'portal_not_found' });
  }
  const identity = panel.find('#lblConnote');
  if (panel.length !== 1 || history.length !== 1 || identity.length !== 1 || identity.text().trim() !== number
    || clean(identity.prev().text()) !== 'Consignment Number') throw new SchemaError(PROVIDER, 'Direct Freight returned another shipment or changed its identity');
  const desktop = history.children('div').filter((_, e) => ($(e).attr('class') ?? '').split(/\s+/).includes('md:grid'));
  const mobile = history.children('div').filter((_, e) => ($(e).attr('class') ?? '').split(/\s+/).includes('md:hidden'));
  if (!desktop.length || desktop.length > 501 || mobile.length !== desktop.length - 1
    || desktop.eq(0).children('div').toArray().map(e => clean($(e).text())).join('|') !== 'Date|Location|Status|Items') {
    throw new SchemaError(PROVIDER, 'Direct Freight changed its responsive history panels');
  }
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (let index = 1; index < desktop.length; index++) {
    const cells = desktop.eq(index).children('div'), alternate = mobile.eq(index - 1).children('div');
    if (cells.length !== 4 || alternate.length !== 4 || cells.toArray().some(e => $(e).text().length > 2000)) throw new SchemaError(PROVIDER, 'Direct Freight returned a malformed scan');
    const values = cells.toArray().map(e => clean($(e).text(), 1000));
    const labels = ['Date:', 'Location:', 'Status:', 'Items:'];
    for (let c = 0; c < 4; c++) {
      const value = alternate.eq(c).clone(), label = value.children('span');
      if (label.length !== 1 || clean(label.text()) !== labels[c]) throw new SchemaError(PROVIDER, 'Direct Freight changed its mobile scan labels');
      label.remove();
      if (value.text().length > 2000 || clean(value.text(), 1000) !== values[c]) throw new SchemaError(PROVIDER, 'Direct Freight returned inconsistent responsive scans');
    }
    const description = values[2]!;
    if (!description || description.length > 500 || values[1]!.length > 160 || (values[3] && !/^\d{1,4}$/.test(values[3]))) throw new SchemaError(PROVIDER, 'Direct Freight changed its scan fields');
    const local = clock(values[0]!), key = JSON.stringify([local, description, values[1]]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = directFreightStage(description);
    events.push({ local_time: local, description, ...(values[1] ? { location: values[1] } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Direct Freight returned no dated consignment scans');
  const eta = panel.find('#lblEtaDetails'), etaLabel = panel.find('#lblEtaLabel');
  if (eta.length !== 1 || etaLabel.length !== 1) throw new SchemaError(PROVIDER, 'Direct Freight changed its delivery estimate');
  const etaText = clean(eta.text(), 80);
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(etaText);
  const expected = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (etaText && (!expected || clean(etaLabel.text()) !== 'Scheduled For Delivery By')) throw new SchemaError(PROVIDER, 'Direct Freight returned an unreadable delivery estimate');
  const staged = directFreightStage(newest.description!);
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    expected_delivery: expected, ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
