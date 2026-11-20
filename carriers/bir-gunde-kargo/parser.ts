import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { birGundeStage } from './status.js';

export const PROVIDER = 'Bir Günde Kargo';
export const BIR_GUNDE_MAX_BYTES = 512 * 1024;
const PAGE = 'https://takip.birgundekargo.com/intranet/Tracking_kargo.asp';
const TITLE = 'Bir Günde Kargo Gönderi Sorgulama';
// The carrier's barcodes; the page takes any other reference as the shop's order number.
const BARCODE = /^B\d{6,12}$/;
const REFERENCE = /^[A-Z0-9]{6,24}$/;
// The alerts the page shows instead of a shipment: a reference it does not know, and a parcel whose round is over.
const ABSENT = 'Takip bilgilerinizi kontrol ediniz.';
const COMPLETED = 'Kargonuzla ilgili süreç tamamlanmıştır.';
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human/i;
const MAX_ROWS = 200;

/** The whole reference as the tracker takes it: a barcode, or the order number the shop gave. */
export function normalizeBirGundeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!REFERENCE.test(number)) throw new InvalidInputError(PROVIDER, 'Bir Günde Kargo needs a barcode or an order number');
  return number;
}

export const isBirGundeBarcode = (number: string): boolean => BARCODE.test(number);

/** The page the tracking form opens for a reference: by barcode, or by the shop's order number. */
export function birGundeUrl(raw: string): string {
  const number = normalizeBirGundeNumber(raw);
  return `${PAGE}?${new URLSearchParams({ [isBirGundeBarcode(number) ? 'bgk_barkod' : 'alici_musteri_kodu']: number })}`;
}

/** "16-11-2026 18.37" as a wall clock, without an offset. */
function wallClock(text: string): string {
  const match = /^(\d{2})-(\d{2})-(\d{4}) ([01]\d|2[0-3])\.([0-5]\d)$/.exec(text);
  const day = match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!day) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned an invalid scan clock');
  return `${day}T${match[4]}:${match[5]}:00`;
}

/** "20.11.2026" as a day. */
function day(text: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** The value under a label in the shipment's details. */
function detail($: CheerioAPI, label: string): string | undefined {
  const values = $('.k-form-box .box-col').filter((_, col) => clean($(col).children('p').first().text(), 80) === label).children('h6');
  if (values.length > 1) throw new SchemaError(PROVIDER, `Bir Günde Kargo repeated its ${label} detail`);
  return values.length ? clean(values.text(), 200) : undefined;
}

/** The text after a summary label ("Gönderi Durumu:"). */
function summary($: CheerioAPI, label: string): string | undefined {
  const lines = $('.k-form-box > p').filter((_, line) => clean($(line).contents().first().text(), 80) === label);
  if (lines.length > 1) throw new SchemaError(PROVIDER, `Bir Günde Kargo repeated its ${label} line`);
  return lines.length ? clean(lines.children('span').text(), 200) : undefined;
}

/**
 * The tracker's page for one reference: its alert for an unknown or finished shipment, or the
 * shipment's details and movements, oldest first. Only the status, the sender's name, the delivery
 * estimate and the movements are read; the recipient, courier and branch staff are left out.
 */
export function parseBirGunde(html: string, raw: string): CarrierResult {
  const number = normalizeBirGundeNumber(raw);
  if (new TextEncoder().encode(html).byteLength > BIR_GUNDE_MAX_BYTES) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned an oversized page');
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bir Günde Kargo requires browser verification');
  const $ = load(html);
  if ($('title').length !== 1 || clean($('title').text()) !== TITLE) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned another page');
  const form = $('.k-form');
  if (!form.length) {
    const scripts = $('script:not([src])').text();
    if (scripts.includes(ABSENT) && !scripts.includes(COMPLETED)) throw new NotFoundError(PROVIDER);
    if (scripts.includes(COMPLETED) && !scripts.includes(ABSENT)) {
      throw new IndeterminateError(PROVIDER, 'Bir Günde Kargo shows only that the shipment is complete, without its history', { reason: 'history_expired' });
    }
    throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned a page without a shipment or a known alert');
  }
  if (form.length !== 1) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned several shipments');

  // The page names its barcode in the links of its map and call buttons; asked by order number, it names that too.
  const barcodes = new Set([...html.matchAll(/[?&]barkod=([A-Za-z0-9]{1,40})\b/g)].map(match => match[1]!.toUpperCase()));
  if (barcodes.size > 1 || [...barcodes].some(barcode => !BARCODE.test(barcode))) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned an unexpected barcode');
  const barcode = [...barcodes][0];
  if (isBirGundeBarcode(number)) {
    if (barcode && barcode !== number) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned another shipment');
  } else {
    const order = detail($, 'Siparis No');
    if (!order || order.length > 64 || normalizeTrackingNumber(order) !== number) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned another shipment');
  }

  const tables = $('#collapseOne table');
  const table = tables.first();
  if ($('#collapseOne').length !== 1 || !tables.length || table.find('thead th').toArray().map(cell => clean($(cell).text(), 40)).join('|') !== 'Tarih|Kargo Durumu') {
    throw new SchemaError(PROVIDER, 'Bir Günde Kargo changed its movements table');
  }
  const rows = table.find('tbody tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned too many movements');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of rows.toArray().reverse()) {
    const cells = $(row).children('td');
    const description = clean(cells.eq(1).text(), 300);
    if (cells.length !== 2 || !description) throw new SchemaError(PROVIDER, 'Bir Günde Kargo returned a malformed movement');
    const stage = birGundeStage(description);
    const event: CarrierEvent = { local_time: wallClock(clean(cells.eq(0).text(), 40)), description,
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Bir Günde Kargo lists the shipment without movements', { reason: 'listed' });

  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  const sender = detail($, 'Gönderen');
  const estimate = day(summary($, 'Tahmini Teslimat Tarihi:') ?? '');
  const settled = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    expected_delivery: !settled && estimate && estimate >= newest.local_time!.slice(0, 10) ? estimate : null,
    ...(sender ? { sender_name: sender } : {}),
    ...(barcode && barcode !== number ? { canonical_tracking_number: barcode } : {}),
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100),
  };
}
