import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { etomarsStage } from './status.js';

export const PROVIDER = 'Etomars';
export const ETOMARS_MAX_BYTES = 1024 * 1024;
const BLOCKED = /_cf_chl_opt|cf-chl-|cf-turnstile|g-recaptcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)|Incapsula incident|verify (?:that )?you are human|403 Forbidden/i;

export function isEtomarsRegistration(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^SN\d{9}JP$/.test(normalizeTrackingNumber(raw));
}

/** Other SHIPNERGY reference modes remain eligible for provider fallback. */
export function normalizeEtomarsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Etomars needs a shipment reference');
  if (!isEtomarsRegistration(number)) throw new NoHistoryError(PROVIDER, 'The dedicated lookup needs a SHIPNERGY registration number', { reason: 'unsupported_reference' });
  return number;
}

function phase(text: string): { code: string; wording: string } {
  const match = /^\[(\d{1,4})\]\s*(\S[\s\S]*)$/.exec(text);
  if (!match || match[2]!.length > 300) throw new SchemaError(PROVIDER, 'SHIPNERGY changed its scan phase');
  return { code: match[1]!, wording: match[2]! };
}

function clock(text: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(text);
  const day = match && calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!match || !day) throw new SchemaError(PROVIDER, 'SHIPNERGY returned an invalid scan clock');
  return `${day}T${match[4]}`;
}

/** Project logistics activities and facilities, leaving arbitrary free comments out. */
function activity(detail: string): { description?: string; location?: string } {
  if (detail === 'JAPAN') return { location: 'JAPAN' };
  if (['KR → JP', 'SHIPNERGY', 'SHIPNERGY Receipt'].includes(detail)) return { description: detail };
  const match = /^(Delivered\s*:\s*)?(配達完了|配達中|保管中|輸送中|発送準備中)(?:\s*\(([^()]*)\))?$/.exec(detail);
  if (!match) return {};
  const facility = match[3]?.trim();
  const location = facility && facility.length <= 160 && /(?:営業所|中継センター|センター|支店|郵便局)$/.test(facility)
    && !/[\r\n<>@]|https?:/i.test(facility) ? facility : undefined;
  return { description: `${match[1] ? 'Delivered : ' : ''}${match[2]}`, ...(location ? { location } : {}) };
}

export function parseEtomars(html: string, raw: string): CarrierResult {
  const number = normalizeEtomarsNumber(raw);
  if (new TextEncoder().encode(html).byteLength > ETOMARS_MAX_BYTES) throw new SchemaError(PROVIDER, 'SHIPNERGY returned an oversized page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'SHIPNERGY returned browser verification');
  const $ = load(html), form = $('form#form1');
  if (form.length !== 1 || form.attr('action') !== '/Track/Result' || form.attr('method')?.toLowerCase() !== 'post'
    || clean($('title').text()) !== 'SHIPNERGY' || $('header.header2 a[href="/Track/Search"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'SHIPNERGY returned no unique tracking view');
  }
  const panels = form.find('#popup .popup-content > .track_content');
  if (!panels.length) {
    const children = form.children();
    if (children.length !== 1 || !children.is('input[type="hidden"][name="__RequestVerificationToken"]')
      || form.text().trim() || $('.track_content, #popup, table').length) {
      throw new SchemaError(PROVIDER, 'SHIPNERGY changed its empty tracking view');
    }
    // The same empty view covers absent and expired registrations.
    throw new NoHistoryError(PROVIDER, 'SHIPNERGY has no available registration history', { reason: 'portal_not_found' });
  }
  if (panels.length !== 1 || $('.track_content').length !== 1) throw new SchemaError(PROVIDER, 'SHIPNERGY returned multiple shipments');
  const panel = panels.eq(0), heading = panel.children('ul[onclick]'), id = panel.attr('id') ?? '';
  const toggle = /^toggle\(this,\s*(['"])(Invoice\d+)\1\)$/.exec(heading.attr('onclick') ?? '');
  const label = heading.children('li').first().text().trim();
  const identity = /^Registration Number\s*\|\s*(\S[\s\S]*)$/.exec(label);
  const current = heading.children('li.ing');
  if (heading.length !== 1 || !toggle || toggle[2] !== id || !identity || identity[1]!.length > 64
    || normalizeTrackingNumber(identity[1]!) !== number || current.length !== 1 || current.text().length > 500) {
    throw new SchemaError(PROVIDER, 'SHIPNERGY returned another registration or changed its heading');
  }
  const summary = phase(clean(current.text(), 500));
  const details = panel.find('table').filter((_, table) => $(table).find('thead th').toArray()
    .map(cell => clean($(cell).text())).join('|').startsWith('Departure country|Destination Country|Registration Number'));
  if (details.length !== 1) throw new SchemaError(PROVIDER, 'SHIPNERGY omitted unique shipment details');
  const labels = details.find('thead th').toArray().map(cell => clean($(cell).text()));
  const rows = details.children('tbody').children('tr'), fields = rows.children('td');
  if (!['Departure country|Destination Country|Registration Number',
    'Departure country|Destination Country|Registration Number|Delivery No|Delivery Company'].includes(labels.join('|'))
    || rows.length !== 1 || fields.length !== labels.length || fields.toArray().some(cell => $(cell).text().length > 256)
    || normalizeTrackingNumber(fields.eq(2).text()) !== number) {
    throw new SchemaError(PROVIDER, 'SHIPNERGY returned inconsistent shipment identity');
  }
  if (clean(fields.eq(0).text()) !== 'Republic of Korea' || clean(fields.eq(1).text()).toUpperCase() !== 'JAPAN') {
    throw new IndeterminateError(PROVIDER, 'This SHIPNERGY service is outside the dedicated lookup scope', { reason: 'unsupported_service' });
  }
  const history = panel.find('table').filter((_, table) => $(table).find('thead th').toArray()
    .map(cell => clean($(cell).text())).join('|') === 'Date|Status|Explanation');
  if (history.length !== 1) throw new SchemaError(PROVIDER, 'SHIPNERGY omitted a unique history');
  const scans = history.children('tbody').children('tr');
  if (scans.length > 500) throw new SchemaError(PROVIDER, 'SHIPNERGY returned excessive history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const scan of scans.toArray()) {
    const cells = $(scan).children('td');
    if (cells.length !== 3 || cells.toArray().some(cell => $(cell).text().length > 1000)) throw new SchemaError(PROVIDER, 'SHIPNERGY returned a malformed scan');
    const local = clock(clean(cells.eq(0).text(), 80)), state = phase(clean(cells.eq(1).text(), 500));
    const detail = activity(clean(cells.eq(2).text(), 1000));
    const description = state.wording + (detail.description ? ` — ${detail.description}` : '');
    const key = JSON.stringify([local, state.code, description, detail.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = etomarsStage(state.code, description);
    events.push({ local_time: local, description, provider_code: state.code, ...(detail.location ? { location: detail.location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'SHIPNERGY returned no dated scans');
  // The portal groups destination phases ahead of customs, even when their clocks are older.
  // This scoped Korean/Japanese service keeps the same local clock in both countries.
  events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const currentEvent = events.find(event => event.provider_code === summary.code);
  const staged = currentEvent ? etomarsStage(currentEvent.provider_code!, currentEvent.description!) : null;
  const partner = fields.eq(4), partnerNumber = normalizeTrackingNumber(fields.eq(3).text());
  const links = partner.find('a'), noLink = fields.eq(3).find('a');
  const sagawaUrl = (url: string | undefined) => url === 'https://e-customer.sagawa-exp.co.jp/k2k';
  const handoff = clean(partner.text()).toUpperCase() === 'SAGAWA' && /^\d{12}$/.test(partnerNumber)
    && links.length === 1 && noLink.length === 1 && sagawaUrl(links.attr('href')) && sagawaUrl(noLink.attr('href'));
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    provider_code: currentEvent?.provider_code ?? summary.code,
    last_status_text: currentEvent?.description ?? summary.wording,
    last_update: null, last_update_local: currentEvent?.local_time ?? events[0]!.local_time, expected_delivery: null,
    destination_country: 'JP', ...(handoff ? { delivery_carrier: 'sagawa', delivery_tracking_number: partnerNumber } : {}),
    ...(events.length > 100 || !currentEvent ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
