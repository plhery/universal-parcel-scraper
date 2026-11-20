import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { yolStage } from './status.js';

export const PROVIDER = 'Yol Kargo';
export const YOL_MAX_BYTES = 512 * 1024;
/** The lookup the tracking form opens: it answers with a redirect to the system that holds the shipment. */
export const YOL_LOOKUP = 'https://yolkargo.com.tr/kargo';
/** Yol Kargo's own shipment system, where the lookup sends a shipment of its network. */
export const YOL_SHIPMENT_PAGE = 'http://185.130.59.105/Elci2017/KargoSorgulaDetay.aspx';
/** Aras Kargo's page for a shipment Yol Kargo handed it, found by Yol Kargo's number under Yol Kargo's account. */
export const ARAS_PARTNER_PAGE = 'http://kargotakip.araskargo.com.tr/CargoInfoV2.aspx';
/** Ful Kargo's tracker, where the lookup sends a number it does not know. */
export const FUL_PAGE = 'http://kargotakip.fulkargo.com.tr:9999/tracking';

const NUMBER = /^\d{7,12}$/;
const GUID = /^[0-9A-F]{32}$/;
const OWN_NETWORK = 4;
const ARAS = 1;
const HEADER = 'YOL KARGO ÜZERİNDE KARGO HAREKETLERİ';
const COLUMNS = ['BARKOD_NO', 'ISLEM', 'TARIH', 'SAAT'];
const FUL_ABSENT = 'Kargo takip kodu bulunamadı..';
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|captcha-delivery\.com|verify (?:that )?you are human/i;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** A Yol Kargo shipment number: the barcode on the label and in the dispatch text, all digits. */
export function normalizeYolNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Yol Kargo shipment numbers are seven to twelve digits');
  return number;
}

export const yolLookupUrl = (raw: string): string => `${YOL_LOOKUP}?${new URLSearchParams({ q: normalizeYolNumber(raw) })}`;

/** Where the lookup sends a number: Yol Kargo's own page, Aras Kargo's under Yol Kargo's account, or Ful Kargo's tracker for a number it does not know. */
export type YolRoute =
  | { system: 'yol'; url: string }
  | { system: 'aras'; url: string }
  | { system: 'none'; url: string };

/** A page a challenge, rather than the tracker, answered. */
export function assertNotBlocked(html: string): void {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Yol Kargo requires browser verification');
}

/**
 * The lookup's answer: a redirect, with the systems that hold the number as a JSON list of
 * `{ url, cpy }` in its body. `cpy` 4 is Yol Kargo's own network, whose `url` is the shipment's
 * id on its page; 1 is Aras Kargo, whose `url` is the query of its page. An empty body sends the
 * browser to Ful Kargo's tracker.
 */
export function parseYolRoute(body: string, location: string | null, raw: string): YolRoute {
  const number = normalizeYolNumber(raw);
  assertNotBlocked(body);
  const text = body.replace(/^\uFEFF/, '').trim();
  if (!location || location.length > 300) throw new IndeterminateError(PROVIDER, 'Yol Kargo lookup moved');
  if (!text) {
    const url = `${FUL_PAGE}?${new URLSearchParams({ har_kod: number })}`;
    if (location !== url) throw new IndeterminateError(PROVIDER, 'Yol Kargo lookup moved');
    return { system: 'none', url };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SchemaError(PROVIDER, 'Yol Kargo lookup changed'); }
  if (!Array.isArray(parsed) || !parsed.length) throw new SchemaError(PROVIDER, 'Yol Kargo lookup changed');
  if (parsed.length > 1) throw new IndeterminateError(PROVIDER, 'Yol Kargo found several shipments for this number');
  const [match] = parsed as unknown[];
  const { url: id, cpy } = (match && typeof match === 'object' ? match : {}) as { url?: unknown; cpy?: unknown };
  if (typeof id !== 'string' || typeof cpy !== 'number') throw new SchemaError(PROVIDER, 'Yol Kargo lookup changed');
  if (cpy === OWN_NETWORK) {
    const url = `${YOL_SHIPMENT_PAGE}?Guid=${id}`;
    if (!GUID.test(id) || location !== url) throw new SchemaError(PROVIDER, 'Yol Kargo lookup changed');
    return { system: 'yol', url };
  }
  if (cpy === ARAS) {
    // Yol Kargo's account at Aras Kargo, the same for every visitor, and its own number as the recipient code.
    const query = new URLSearchParams(id);
    const url = `${ARAS_PARTNER_PAGE}?${id}`;
    if ([...query.keys()].join() !== 'accountid,sifre,alici_kod' || !GUID.test(query.get('accountid')!)
      || !/^[A-Z0-9]{1,16}$/.test(query.get('sifre')!) || query.get('alici_kod') !== number || location !== url) {
      throw new SchemaError(PROVIDER, 'Yol Kargo lookup changed');
    }
    return { system: 'aras', url };
  }
  throw new IndeterminateError(PROVIDER, 'Yol Kargo handed the shipment to a partner the library does not read');
}

/** Ful Kargo's tracker for a number Yol Kargo's lookup does not know: its notice that it does not know it either. */
export function parseFulAnswer(html: string, raw: string): never {
  normalizeYolNumber(raw);
  assertNotBlocked(html);
  const $ = load(html);
  const alerts = $('.alert');
  if (alerts.length === 1 && alerts.hasClass('alert-danger') && clean(alerts.text(), 80) === FUL_ABSENT) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'Ful Kargo answered for a number Yol Kargo does not know');
}

/** "21.04.2025" and "12:55:04" as a wall clock, without an offset. */
function wallClock(date: string, time: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  const clock = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(time);
  const day = match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!day || !clock) throw new SchemaError(PROVIDER, 'Yol Kargo returned an invalid scan clock');
  return `${day}T${time}`;
}

/**
 * Yol Kargo's page for one shipment: its movements, oldest first, each naming the barcode. The
 * recipient's masked name, the goods and the proof-of-delivery picture are not read.
 */
export function parseYolShipment(html: string, raw: string): CarrierResult {
  const number = normalizeYolNumber(raw);
  if (new TextEncoder().encode(html).byteLength > YOL_MAX_BYTES) throw new SchemaError(PROVIDER, 'Yol Kargo returned an oversized page');
  assertNotBlocked(html);
  const $ = load(html);
  // The shipment system serves several networks; the header names the one that answers.
  const header = $('#LBL_KARGO_HEADER');
  if (header.length !== 1 || clean(header.text(), 80) !== HEADER) throw new SchemaError(PROVIDER, 'Yol Kargo returned another page');
  const barcode = $('#lblBarkodNo');
  if (barcode.length !== 1) throw new SchemaError(PROVIDER, 'Yol Kargo shipment page changed');
  const shown = clean(barcode.text(), 40);
  if (!shown) throw new IndeterminateError(PROVIDER, 'Yol Kargo did not return the shipment');
  if (shown !== number) throw new SchemaError(PROVIDER, 'Yol Kargo returned another shipment');

  const grid = $('table#GridTarihce');
  if (grid.length > 1) throw new SchemaError(PROVIDER, 'Yol Kargo repeated its movements');
  // The grid is left out when the shipment has no movement yet.
  if (!grid.length) throw new NoHistoryError(PROVIDER, 'Yol Kargo lists the shipment without movements', { reason: 'listed' });
  const rows = grid.find('tr').toArray();
  if (rows.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, 'Yol Kargo returned too many movements');
  const columns = $(rows[0]).children('th').toArray().map(cell => clean($(cell).text(), 40));
  if (columns.join('|') !== COLUMNS.join('|')) throw new SchemaError(PROVIDER, 'Yol Kargo changed its movements table');

  const scans: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const cells = $(row).children('td').toArray().map(cell => clean($(cell).text(), 200));
    const [code, description, date, time] = cells;
    if (cells.length !== COLUMNS.length || !description) throw new SchemaError(PROVIDER, 'Yol Kargo returned a malformed movement');
    if (code !== number) throw new SchemaError(PROVIDER, 'Yol Kargo returned another shipment\'s movement');
    const stage = yolStage(description);
    const event: CarrierEvent = { local_time: wallClock(date!, time!), description, ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); scans.push(event); }
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'Yol Kargo lists the shipment without movements', { reason: 'listed' });
  // Newest first; rows of the same second keep the page's order.
  const events = scans.map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.local_time! < right.event.local_time! ? 1 : left.event.local_time! > right.event.local_time! ? -1 : right.index - left.index)
    .map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find(event => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(staged ? { current_stage: stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null,
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}

/**
 * Aras Kargo's summary frame for a shipment Yol Kargo handed it: Aras Kargo's own number for it,
 * once the frame shows Yol Kargo's number as the sender's waybill (`AB` and the number).
 */
export function arasNumberFor(html: string, raw: string): string {
  const number = normalizeYolNumber(raw);
  assertNotBlocked(html);
  const $ = load(html);
  const code = $('#labelShipmentCode'), waybill = $('#labelTradingWaybillNumber');
  if (code.length !== 1 || waybill.length !== 1) throw new IndeterminateError(PROVIDER, 'Aras Kargo did not return the shipment Yol Kargo handed it');
  const reference = /^[A-Z]{0,4}(\d{7,12})$/.exec(clean(waybill.text(), 40));
  if (!reference || reference[1] !== number) throw new SchemaError(PROVIDER, 'Aras Kargo returned another shipment');
  const aras = clean(code.text(), 40);
  if (!/^\d{13}$/.test(aras)) throw new SchemaError(PROVIDER, 'Aras Kargo shipment summary changed');
  return aras;
}

/** The summary frame Aras Kargo's page for a handed shipment opens, bound to it by an opaque id. */
export function arasPartnerFrame(html: string): string {
  assertNotBlocked(html);
  const $ = load(html);
  const links = $('a[href^="CargoInfoWaybillAndDelivered.aspx"]').toArray().map(link => $(link).attr('href') ?? '');
  const frames = [...new Set(links)];
  if (!frames.length) throw new IndeterminateError(PROVIDER, 'Aras Kargo did not open the shipment Yol Kargo handed it');
  if (frames.length > 1 || !/^CargoInfoWaybillAndDelivered\.aspx\?shipmentid=[0-9A-F]{32}&subekod=\d{0,6}$/.test(frames[0]!)) {
    throw new SchemaError(PROVIDER, 'Aras Kargo partner page changed');
  }
  return frames[0]!;
}
