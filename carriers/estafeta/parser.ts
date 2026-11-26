import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { paddedDate } from '../../core/time/fields.js';
import { clean } from '../../core/transport/index.js';
import { estafetaStatus, estafetaWording, estafetaRoundNotice } from './status.js';

export interface EstafetaLookup {
  number: string;
  guide: string;
  latestDate: string;
  latestClock: string;
  state: string;
  service?: string;
  // Set when the guide exists but Estafeta has not yet received the parcel.
  registered?: string;
  // Set when the summary shows the current step in red: the parcel is held back after that step's scan.
  held?: true;
}

const LABEL_ONLY = 'la guia ha sido generada sin embargo el envio aun no es depositado en estafeta';

// A letter can take the 13th or 14th place (two-day guides carry a D in the 14th).
const FULL_GUIDE = /^(?:\d{12}[A-Z0-9]{2}\d{8}|\d{15}[A-Z0-9]{7})$/;

export function normalizeEstafetaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{10}$/.test(number) && !FULL_GUIDE.test(number)) throw new InvalidInputError('Estafeta', 'Estafeta requires a tracking code or full guide');
  return number;
}

function page(html: string) {
  const $ = load(html);
  if (/just a moment|verify.*human|captcha/i.test($('title').text()) || $('.g-recaptcha,.h-captcha,#challenge-form').length) throw new ChallengeError('Estafeta');
  $('script,style,noscript').remove();
  return $;
}

export function parseEstafetaLookup(html: string, rawNumber: string): EstafetaLookup {
  const number = normalizeEstafetaNumber(rawNumber);
  const $ = page(html);
  const cards = $('.shipmentByOne');
  if ($('[data-tracking-code],.clsnTrackingCode,.multiplesWaybillList,.MultipleLink').length || cards.length > 1) {
    throw new IndeterminateError('Estafeta', 'Estafeta requires a specific single-piece guide');
  }
  if (!cards.length && $('.TimeLineErrorRow h4').length === 1
    && clean($('.TimeLineErrorRow h4').text()) === 'Lo sentimos, no se encontró información') {
    // The observed error omits the requested reference and also describes
    // unavailable information; it does not prove parcel absence. It is still Estafeta's own empty answer.
    throw new IndeterminateError('Estafeta', 'Estafeta returned no bound parcel information', { reason: 'portal_not_found' });
  }
  if (cards.length !== 1 || cards.find('.shipmentInfoDiv').length !== 1 || $('title').text().trim() !== 'Resultado') throw new SchemaError('Estafeta');
  const field = (label: string) => {
    const nodes = cards.find('.shipmentInfoSeparator').filter((_, node) => clean($(node).children('.fontRoman').text()) === label);
    if (nodes.length !== 1 || nodes.children('.fontBold').length !== 1) throw new SchemaError('Estafeta', 'Estafeta returned incomplete parcel identity');
    return clean(nodes.children('.fontBold').text(), 64);
  };
  const guide = field('Número de guía:');
  const code = field('Código de rastreo:');
  if (!FULL_GUIDE.test(guide) || !/^\d{10}$/.test(code) || (number.length === 10 ? code !== number : guide !== number)) {
    throw new SchemaError('Estafeta', 'Estafeta returned a different parcel');
  }
  const controls = cards.find('.showHistory');
  if (controls.length !== 1 || controls.attr('data-shipment-index') !== guide) throw new SchemaError('Estafeta', 'Estafeta returned a different history target');
  const services = cards.find('.shipmentInfoSeparator').filter((_, node) => clean($(node).children('.fontRoman').text()) === 'Servicio:');
  const service = services.length === 1 ? clean(services.children('.fontBold').text(), 80) : '';
  // The current step, in the colour of a step under way, or in red with a "!" beside it while the parcel is held back,
  // as when it waits to be scheduled for a round. The newest scan then gives the stage.
  const state = cards.find('.stateDescription.fontColorCurrentProcess, .stateDescription.fontColorError');
  const messages = cards.find('.fontColorCurrentProcessMessage');
  const notice = cards.find('#i09');
  if (!state.length && !messages.length && notice.length === 1 && estafetaWording(notice.text()) === LABEL_ONLY) {
    return { number, guide, state: '', latestClock: '', latestDate: '', registered: clean(notice.text(), 200), ...(service ? { service } : {}) };
  }
  const parts = messages.contents().filter((_, node) => node.nodeType === 3).map((_, node) => clean($(node).text(), 100)).get().filter(Boolean);
  if (state.length !== 1 || messages.length !== 1 || parts.length < 2) throw new SchemaError('Estafeta', 'Estafeta returned incomplete latest activity');
  return { number, guide, state: clean(state.text(), 200), latestClock: parts[0]!, latestDate: parts[1]!, ...(service ? { service } : {}),
    ...(state.is('.fontColorError') ? { held: true as const } : {}) };
}

// A label-only guide has no scans yet, so the notice stands alone as its status.
export function estafetaRegistered(lookup: EstafetaLookup): CarrierResult {
  return { status: 'pending', current_stage: 'registered', last_status_text: lookup.registered ?? null, last_update: null, last_update_local: null, expected_delivery: null,
    ...(lookup.service ? { service_name: lookup.service } : {}), ...(lookup.number !== lookup.guide ? { canonical_tracking_number: lookup.guide } : {}), summary_only: true, events: [] };
}

/** A date group's target, the guide and the group's index after the collapse's name, which Estafeta spells "remainig". */
function targetsGuide(target: string, guide: string): boolean {
  const name = /^#remainin?gEventInfo/.exec(target)?.[0];
  return name !== undefined && target.startsWith(guide, name.length) && /^\d{1,3}$/.test(target.slice(name.length + guide.length));
}

function clockText(raw: string): string { return raw.replace(/\s+hrs\.$/i, '').trim(); }

function clock(day: string, time: string): { local_time?: string; provider_time_text?: string } {
  const date = paddedDate(day);
  const rawClock = paddedDate(clockText(time));
  const validated = /^\d{2}\/\d{2}\/\d{4}$/.test(date) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rawClock)
    ? DateTime.fromFormat(`${date} ${rawClock}`, 'dd/MM/yyyy HH:mm', { zone: 'UTC' }) : null;
  return validated?.isValid ? { local_time: validated.toISO({ includeOffset: false, suppressMilliseconds: true }) }
    : { provider_time_text: clean(`${day} ${time}`, 100) };
}

export function parseEstafetaHistory(html: string, lookup: EstafetaLookup): CarrierResult {
  const $ = page(html);
  const groups = $('.historyEventRow');
  if (!groups.length) throw new IndeterminateError('Estafeta', 'Estafeta returned no parcel history');
  if (groups.length > 500 || $('.eventInfo').length > 500) throw new SchemaError('Estafeta', 'Estafeta returned excessive history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let scanCount = 0;
  const scans: Array<{ day: string; clock: string; description: string }> = [];
  for (const group of groups.toArray()) {
    const root = $(group);
    const bindings = root.find('.remainingHistoryEvents[data-shipmentindex]');
    const dayCell = root.children('.col-xs-2');
    const eventBox = root.children('.col-xs-9');
    const rows = eventBox.find('.eventInfo');
    // A day's later scans sit in a collapse naming the guide, which the group's target names too. A day with a single
    // scan has no collapse, so its target names the guide alone.
    const target = root.attr('data-target');
    const bound = bindings.length === 1 ? bindings.attr('data-shipmentindex') === lookup.guide : bindings.length === 0 && rows.length === 1 && target !== undefined;
    if (!bound || (target !== undefined && !targetsGuide(target, lookup.guide)) || dayCell.length !== 1 || eventBox.length !== 1
      || root.find('.historyEventRow').length) throw new SchemaError('Estafeta', 'Estafeta returned a different or ambiguous history group');
    const day = clean(dayCell.text(), 64);
    if (!rows.length) throw new SchemaError('Estafeta', 'Estafeta returned an empty history group');
    for (const row of rows.toArray()) {
      const cells = $(row).children('div');
      if (cells.length !== 3 || cells.eq(0).is('.col-sm-2') === false || cells.eq(1).is('.col-sm-3') === false || cells.eq(2).is('.col-sm-7') === false) throw new SchemaError('Estafeta');
      const time = clean(cells.eq(0).text(), 64);
      const description = clean(cells.eq(2).text(), 500);
      if (!description) throw new SchemaError('Estafeta', 'Estafeta returned an empty scan');
      scanCount++;
      scans.push({ day, clock: clockText(time), description });
      const mapped = estafetaStatus(description);
      const event: CarrierEvent = { ...clock(day, time), description, location: clean(cells.eq(1).text(), 200), ...(mapped ? { stage: mapped.stage } : {}) };
      const key = JSON.stringify(event);
      if (!seen.has(key)) { seen.add(key); events.push(event); }
    }
  }
  if (scanCount !== $('.eventInfo').length) throw new SchemaError('Estafeta', 'Estafeta returned scans outside its parcel groups');
  // The summary dates the newest scan, or, for a parcel held back, the newest scan of the step it shows: the notice that
  // holds the parcel, such as the wait to be scheduled for a round, comes after it. The step shows in red while the
  // parcel is held, and later as under way while that notice is still the newest scan.
  const holding = lookup.held || (scans[0] !== undefined && estafetaRoundNotice(scans[0].description));
  const anchor = holding ? scans.find(({ description }) => estafetaWording(description) === estafetaWording(lookup.state)) : scans[0];
  if (anchor?.day !== lookup.latestDate || anchor.clock !== clockText(lookup.latestClock)) throw new IndeterminateError('Estafeta', 'Estafeta latest summary does not match its first scan');
  const latest = events[0]!;
  const current = estafetaStatus(String(latest.description));
  const summary = estafetaStatus(lookup.state);
  if ((current?.stage === 'delivered' || summary?.stage === 'delivered') && current?.stage !== summary?.stage) throw new IndeterminateError('Estafeta', 'Estafeta returned inconsistent delivery evidence');
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time ?? null, expected_delivery: null,
    ...(lookup.service ? { service_name: lookup.service } : {}), ...(lookup.number !== lookup.guide ? { canonical_tracking_number: lookup.guide } : {}), events: events.slice(0, 100) };
}
