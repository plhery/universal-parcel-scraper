import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { huunehStage, statusMap } from './status.js';

export const PROVIDER = 'Huuneh';
export const HUUNEH_TRACK_URL = 'https://huuneh.com/dashboard/track.php';
// A delivered parcel's page is about 15 kB.
export const HUUNEH_MAX_BYTES = 512 * 1024;
const MAX_SCANS = 200;
// The form's example and the public sample are AWB and ten digits; the tracker can be set to another prefix.
const NUMBER = /^[A-Z]{2,5}\d{6,14}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|hcaptcha|grecaptcha|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human|checking your browser/i;

/** One waybill for Huuneh's tracker: letters then digits. The form also takes lists, which the adapter never sends. */
export function normalizeHuunehNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Huuneh waybills are a letter prefix such as AWB and digits');
  return number;
}

export function huunehUrl(raw: string): string {
  return `${HUUNEH_TRACK_URL}?${new URLSearchParams({ order_track: normalizeHuunehNumber(raw) })}`;
}

/** `2026/08/11` and `03:16:01 pm` as a wall clock: the page names no zone. */
function wallClock(day: string, time: string): string {
  const date = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(day), clock = /^(\d{2}):([0-5]\d):([0-5]\d) ([ap]m)$/i.exec(time);
  const iso = date ? calendarDay(Number(date[1]), Number(date[2]), Number(date[3])) : null;
  const hour12 = clock ? Number(clock[1]) : 0;
  if (!iso || iso < '2000-01-01' || !clock || hour12 < 1 || hour12 > 12) throw new SchemaError(PROVIDER, 'Huuneh returned an invalid scan clock');
  const hour = (hour12 % 12) + (clock[4]!.toLowerCase() === 'pm' ? 12 : 0);
  return `${iso}T${String(hour).padStart(2, '0')}:${clock[2]}:${clock[3]}`;
}

/** A labelled value of the page's sender or recipient block: `<label>Name</br> <b>value</b></label>`. */
function labelled($: CheerioAPI, block: ReturnType<CheerioAPI>, name: string): string {
  const values = block.find('label').filter((_, node) => clean($(node).clone().children('b').remove().end().text(), 80) === name);
  if (values.length > 1) throw new SchemaError(PROVIDER, `Huuneh repeated its ${name} field`);
  return values.length ? clean(values.find('b').text(), 200) : '';
}

const folded = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Read the page `track.php` returns for one waybill: its history, an unknown waybill, or a failure of its own kind. */
export function parseHuuneh(html: string, raw: string): CarrierResult {
  const number = normalizeHuunehNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Huuneh answered with browser verification');
  const $ = load(html);
  $('script,style,template').remove();
  if (!/\|\s*Huuneh\s*$/.test(clean($('title').text(), 120))) throw new SchemaError(PROVIDER, 'Huuneh returned another page');
  const shipment = $('.trackstatus-title label b');
  const absent = $('.display-6').filter((_, node) => /^Invoice number not found\b/.test(clean($(node).text(), 200)));
  if (absent.length) {
    // The unknown-waybill page echoes what was asked, as the server read it.
    if (absent.length !== 1 || shipment.length || normalizeTrackingNumber(clean(absent.find('strong').text(), 80)) !== number) {
      throw new SchemaError(PROVIDER, 'Huuneh returned an unbound not-found page');
    }
    throw new NotFoundError(PROVIDER);
  }
  if (shipment.length !== 1 || normalizeTrackingNumber(clean(shipment.text(), 80)) !== number) {
    throw new SchemaError(PROVIDER, 'Huuneh did not identify the requested waybill');
  }
  const heading = clean($('.trackstatus-title p b').first().text(), 120);
  if (!heading) throw new SchemaError(PROVIDER, 'Huuneh returned a shipment without its status');

  const rows = $('.booking-summary-box ul.timeline li.event');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Huuneh returned too long a history');
  const scans: { event: CarrierEvent; index: number }[] = [];
  rows.each((index, row) => {
    const item = $(row), title = item.find('h6');
    if (title.length !== 1) throw new SchemaError(PROVIDER, 'Huuneh returned a scan without its status');
    const local = wallClock(clean(item.find('p.text-left').text(), 20), clean(item.find('p.text-right').text(), 20));
    // The status name, then after line breaks a note that starts with `+`.
    const [status = '', ...rest] = (title.html() ?? '').split(/<br\s*\/?>/i).map(part => clean(load(part).root().text(), 300));
    const note = clean(rest.join(' '), 300).replace(/^\+\s*/, '');
    if (!status) throw new SchemaError(PROVIDER, 'Huuneh returned an unnamed scan');
    const stage = huunehStage(status);
    const description = note && folded(note) !== folded(status) ? `${status}: ${note}` : status;
    scans.push({ index, event: { local_time: local, description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } });
  });
  // The page lists the oldest scan first; the page's order settles scans of one second.
  scans.sort((left, right) => right.event.local_time!.localeCompare(left.event.local_time!) || right.index - left.index);
  const events = scans.map(scan => scan.event);
  const headingStage = huunehStage(heading);
  const stage = (events.length ? leadingScan(events, statusMap)?.stage : headingStage) as Stage | undefined;

  const [sender, recipient] = ['Sender', 'Recipient'].map(name => $('.payment-wrap').filter((_, node) => clean($(node).find('h5.form_sub').first().text(), 40) === name));
  if (sender!.length !== 1 || recipient!.length !== 1) throw new SchemaError(PROVIDER, 'Huuneh changed its shipment blocks');
  const senderName = labelled($, sender!, 'Contact Name');
  const receiverName = labelled($, recipient!, 'Contact Name');
  const address = [labelled($, recipient!, 'Contact Address'), labelled($, recipient!, 'Destination city')].filter(Boolean).join('\n');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]?.description ?? heading,
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: null,
    ...(senderName ? { sender_name: senderName } : {}),
    ...(receiverName ? { receiver_name: receiverName } : {}),
    ...(address ? { receiver_address: address } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
