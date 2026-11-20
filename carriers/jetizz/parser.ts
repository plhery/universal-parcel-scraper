import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { jetizzStage } from './status.js';

export const PROVIDER = 'Jetizz';

// Jetizz's own ten-digit waybills, and the thirteen-digit numbers of the partner that delivers them.
const NUMBER = /^(?:\d{10}|\d{13})$/;
// The partner the movements name as where they happened, and its numbers.
const PARTNER = 'ARASKARGO';
const PARTNER_NUMBER = /^6[05]\d{11}$/;
// The tracker's notices for a refused captcha answer and for a number it does not know.
const REFUSED = 'Doğrulama kodu hatalı veya boş !';
const ABSENT = 'Gönderi bulunamadı!';
const MOVEMENTS = 'Gönderi Hareketleri';
const DETAILS = 'Gönderi Hareket Detayları';
const MOVEMENT_HEADER = ['Durum', 'Tarih', 'İşlem', 'İşlem Yeri'];
const DETAIL_HEADER = ['Durum', 'Tarih', 'İşlem', 'Açıklama', 'İşlem Yeri'];
const MAX_ROWS = 200;

/** A Jetizz waybill, or the partner's number the tracker also answers for. */
export function isJetizzNumber(number: string): boolean {
  return NUMBER.test(number);
}

/** A day ("16.11.2026") or a wall clock ("20.10.2026 12:47:00") as the tracker writes it, without an offset. */
function wallClock(text: string): string | null {
  const clock = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(text);
  if (!clock) return null;
  const [, day, month, year, hour, minute, second] = clock;
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = DateTime.fromObject({ year: +year!, month: +month!, day: +day!,
    ...(hour ? { hour: +hour, minute: +minute!, second: +second! } : {}) }, { zone: 'UTC' });
  if (!parsed.isValid) return null;
  return parsed.toFormat(hour ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
}

function cells($: CheerioAPI, row: AnyNode): string[] {
  return $(row).children('th, td').toArray().map(cell => clean($(cell).text(), 400));
}

/** The rows of the panel titled `title`, after its header; the first row may be the current status in header cells. */
function panel($: CheerioAPI, title: string, header: readonly string[]): { rows: Cheerio<AnyNode>[]; table: string[][] } {
  const boxes = $('.widget-box').filter((_, box) => clean($(box).find('h4.widget-title').first().text(), 80) === title);
  if (boxes.length !== 1) throw new SchemaError(PROVIDER, `Jetizz ${title} panel changed`);
  const rows = boxes.find('table tr').toArray();
  if (!rows.length || cells($, rows[0]!).join('\u0000') !== header.join('\u0000')) throw new SchemaError(PROVIDER, `Jetizz ${title} panel changed`);
  if (rows.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, `Jetizz returned too many rows in ${title}`);
  return { rows: rows.slice(1).map(row => $(row)), table: rows.slice(1).map(row => cells($, row)) };
}

type Scan = { event: CarrierEvent; day: string; order: number; index: number };

/**
 * The tracker's reply for one number: the shipment's details, its movements in Jetizz's words
 * ("Gönderi Hareketleri", the current status first) and the partner's scans ("Gönderi Hareket
 * Detayları"), each list oldest first and dated by the day.
 */
export function parseJetizz(html: string, number: string): CarrierResult {
  const $ = load(html);
  const notice = clean($('.alert').first().text(), 200);
  if (notice === REFUSED) throw new ChallengeError(PROVIDER, 'Jetizz refused the captcha answer');
  if (notice === ABSENT) throw new NotFoundError(PROVIDER);
  if (notice) throw new IndeterminateError(PROVIDER, 'Jetizz answered with an unknown notice');

  const fields = new Map<string, string>();
  for (const row of $('table.table-detay tr').toArray()) {
    const label = clean($(row).find('td.td-baslik').text(), 80);
    if (label) fields.set(label, clean($(row).find('td.td-deger').text(), 200));
  }
  if (!fields.has('Takip No')) throw new SchemaError(PROVIDER, 'Jetizz shipment details changed');
  const waybill = fields.get('Takip No')!;
  const partnerNumber = fields.get('Kargo Takip No') ?? '';
  // The tracker answers for the partner's number too; the shipment must be the one asked for.
  if (waybill !== number && partnerNumber !== number) throw new SchemaError(PROVIDER, 'Jetizz answered for another shipment');

  const scans: Scan[] = [];
  const add = (day: string, local: string, description: string, location: string, order: number) => {
    const classified = jetizzStage(description);
    const event: CarrierEvent = { local_time: local, description, ...(location ? { location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
    scans.push({ event, day, order, index: scans.length });
  };

  const movements = panel($, MOVEMENTS, MOVEMENT_HEADER);
  let current: { text: string; clock: string | null } | null = null;
  let partnerNamed = false;
  movements.table.forEach((row, index) => {
    // The current status opens the list in header cells: a mark, its clock when it has one, and its wording.
    if (index === 0 && movements.rows[index]!.children('th').length) {
      const [, clock = '', text = ''] = row;
      if (!text) throw new SchemaError(PROVIDER, 'Jetizz returned an empty current status');
      current = { text, clock: clock ? wallClock(clock) : null };
      if (clock && !current.clock) throw new SchemaError(PROVIDER, 'Jetizz returned an invalid status time');
      return;
    }
    const [, date = '', description = '', place = ''] = row;
    const day = wallClock(date);
    if (row.length !== 4 || !day || day.length !== 10 || !description) throw new SchemaError(PROVIDER, 'Jetizz returned an invalid movement');
    // A movement at the partner names the partner, not a place.
    if (place === PARTNER) partnerNamed = true;
    add(day, day, description, place === PARTNER ? '' : place, 1);
  });
  for (const row of panel($, DETAILS, DETAIL_HEADER).table) {
    const [, date = '', description = '', , place = ''] = row;
    const day = wallClock(date);
    if (row.length !== 5 || !day || day.length !== 10 || !description) throw new SchemaError(PROVIDER, 'Jetizz returned an invalid partner scan');
    add(day, day, description, place, 0);
  }
  const status = current as { text: string; clock: string | null } | null;
  // A status with its clock, as a delivery's, is the newest scan of its day.
  if (status?.clock) add(status.clock.slice(0, 10), status.clock, status.text, '', 2);

  // Newest first: by day, then the clocked status, Jetizz's movements and the partner's scans, each list newest first.
  scans.sort((left, right) => left.day !== right.day ? (left.day < right.day ? 1 : -1)
    : left.order !== right.order ? right.order - left.order : right.index - left.index);
  const events = scans.map(({ event }) => event);
  if (!status && !events.length) throw new IndeterminateError(PROVIDER, 'Jetizz found the shipment without its status');

  const named = status ? jetizzStage(status.text) : null;
  const staged = events.find(event => event.stage);
  const stage = (named?.stage ?? staged?.stage) as Stage | undefined;
  const source = named?.source ?? staged?.stage_source;
  const receiver = fields.get('Alıcı') ?? '';
  const sender = fields.get('Gönderen') ?? '';
  const address = fields.get('Alıcı İl/İlçe') ?? '';
  const taker = fields.get('Teslim Alan') ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: status?.text ?? events[0]!.description!,
    last_update: null,
    ...(scans[0] ? { last_update_local: scans[0].event.local_time } : {}),
    expected_delivery: null,
    ...(sender ? { sender_name: sender } : {}),
    ...(receiver ? { receiver_name: receiver } : {}),
    ...(address ? { receiver_address: address } : {}),
    ...(stage === 'delivered' && taker ? { signed_by: taker } : {}),
    ...(partnerNamed && PARTNER_NUMBER.test(partnerNumber) && partnerNumber !== number
      ? { delivery_carrier: 'aras-kargo', delivery_tracking_number: partnerNumber } : {}),
    ...(waybill !== number ? { canonical_tracking_number: waybill } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
