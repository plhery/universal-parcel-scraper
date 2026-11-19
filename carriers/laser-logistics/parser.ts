import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { laserStage } from './status.js';

export const PROVIDER = 'Laser Logistics';
export const LASER_URL = 'https://www.laserlogistics.co.za/parcel-tracking/';
// A page is about 60 kB, most of it the site's own markup.
export const LASER_MAX_BYTES = 1024 * 1024;
// South Africa keeps UTC+2 all year, and every branch is in South Africa.
const ZONE = 'Africa/Johannesburg';
// Letters and digits with at least one digit: the tracker matches whole waybills only.
const NUMBER = /^(?=[A-Z0-9]*\d)[A-Z0-9]{6,20}$/;
// The reply the page dumps into a comment: the tracking service's XML and its error text.
const DATA = /<!--\s*DATA:\s*stdClass Object\s*\(([\s\S]*?)\n\)\s*-->/;
const RETURN_DATA = /\[pcReturnData\] =>([\s\S]*?)\n\s*\[pcGeneralError\] =>(.*)/;
const NOT_FOUND = /^Waybill \/ Parcel with number '([^']*)' could not be found\.?$/i;
const FORM = /<form\b[^>]*\bname="parcel-tracking"/i;
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected)|g-recaptcha|hcaptcha/i;
const MAX_EVENTS = 100;

/** A waybill number in capitals, as the tracker shows it. */
export function normalizeLaserNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Laser Logistics waybill numbers are six to twenty letters and digits');
  return number;
}

interface Scan { time: string; timestamp: number; description: string; code: string }
interface Waybill { number: string; status: string; statusCode: string; service: string; weight: string; delivered: string | null; scans: Scan[] }

function instant(text: string, format: string): { iso: string; timestamp: number } {
  const parsed = zonedTime(text, format, ZONE);
  if (!parsed || parsed.iso < '2000') throw new SchemaError(PROVIDER, 'Laser Logistics returned an invalid scan time');
  return parsed;
}

function scanOf(clock: string, format: string, description: string, code: string): Scan {
  const wording = clean(description, 300);
  if (!wording) throw new SchemaError(PROVIDER, 'Laser Logistics returned a scan without wording');
  const { iso, timestamp } = instant(clock, format);
  return { time: iso, timestamp, description: wording, code: clean(code, 20) };
}

/** The service's XML: one `Waybill` with its `TrackingEvents`, oldest first, dates as `ddMMyyyy` and clocks as `HHmm`. */
function fromXml(xml: string): Waybill | null {
  const $ = load(xml, { xml: true });
  const detail = $('ShipmentDetail');
  if (detail.length !== 1) throw new SchemaError(PROVIDER, 'Laser Logistics returned an unreadable reply');
  const waybills = detail.children('Waybill');
  if (!waybills.length) return null;
  if (waybills.length > 1) throw new IndeterminateError(PROVIDER, 'Laser Logistics answered with several waybills');
  const field = (name: string) => clean(waybills.children(name).first().text(), 200);
  const deliveredDate = field('DeliveredDate');
  return {
    number: field('WaybillNumber'), status: field('CurrentStatus'), statusCode: field('CurrentStatusCode'),
    service: field('ServiceType'), weight: field('TotalWeight'),
    delivered: deliveredDate ? instant(`${deliveredDate} ${field('DeliveredTime') || '0000'}`, 'ddMMyyyy HHmm').iso : null,
    scans: waybills.children('TrackingEvents').toArray().map((node) => {
      const event = $(node);
      const text = (name: string) => clean(event.children(name).first().text(), 400);
      return scanOf(`${text('EventDate')} ${text('EventTime')}`, 'ddMMyyyy HHmm', text('EventDescription'), text('EventCode'));
    }),
  };
}

/** The table the page shows: the waybill's facts in label and value pairs, then its scans newest first, without codes. */
function fromTable($: CheerioAPI): Waybill | null {
  const facts = new Map<string, string>();
  $('.table_border tr.waybill-info').each((_, row) => {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 200));
    for (let index = 0; index + 1 < cells.length; index += 2) facts.set(cells[index]!.toLowerCase(), cells[index + 1]!);
  });
  if (!facts.size) return null;
  const date = facts.get('delivered date');
  return {
    number: facts.get('waybill number') ?? '', status: facts.get('current status') ?? '', statusCode: '',
    service: facts.get('service type') ?? '', weight: facts.get('total weight (kg)') ?? '',
    delivered: date ? instant(`${date} ${facts.get('delivered time') || '00:00'}`, 'yyyy-MM-dd HH:mm').iso : null,
    scans: $('.events-info tbody tr').toArray().map((row) => {
      const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 400));
      if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Laser Logistics changed its scan table');
      return scanOf(`${cells[0]} ${cells[1]}`, 'yyyy-MM-dd HH:mm', cells[3]!, '');
    }).reverse(),
  };
}

function notFound(text: string, number: string): void {
  const match = NOT_FOUND.exec(text);
  if (!match) return;
  if (normalizeTrackingNumber(match[1]!).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Laser Logistics answered for another waybill');
  throw new NotFoundError(PROVIDER);
}

/**
 * The page `parcel-tracking/?waybillnumber=` renders for one waybill. It dumps the tracking
 * service's reply, XML with event codes and an error text, into a comment, then shows the
 * waybill's facts and its scans in tables, or the error above the form. The comment is read
 * first, the tables when it is gone.
 */
export function parseLaser(html: string, raw: string): CarrierResult {
  const number = normalizeLaserNumber(raw);
  if (!FORM.test(html)) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Laser Logistics answered with a CAPTCHA or block page');
    throw new SchemaError(PROVIDER, 'Laser Logistics did not return its tracking page');
  }
  let waybill: Waybill | null;
  const data = DATA.exec(html);
  if (data) {
    const parts = RETURN_DATA.exec(data[1]!);
    if (!parts) throw new SchemaError(PROVIDER, 'Laser Logistics changed its reply');
    const error = clean(parts[2], 300);
    notFound(error, number);
    if (error) throw new IndeterminateError(PROVIDER, `Laser Logistics answered: ${error}`);
    waybill = fromXml(parts[1]!.trim());
    if (!waybill) throw new IndeterminateError(PROVIDER, 'Laser Logistics returned no waybill and no error');
  } else {
    const $ = load(html);
    waybill = fromTable($);
    if (!waybill) {
      for (const node of $('.copy p').toArray()) notFound(clean($(node).text(), 300), number);
      throw new SchemaError(PROVIDER, 'Laser Logistics returned a page without a waybill or its notice');
    }
  }
  // The waybill the service names is the page's only identity.
  if (normalizeTrackingNumber(waybill.number).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Laser Logistics answered for another waybill');
  if (!waybill.scans.length) throw new NoHistoryError(PROVIDER);

  // Newest first; scans on the same minute keep the service's order turned round, as the page shows them.
  const events: CarrierEvent[] = waybill.scans.map((scan, index) => ({ scan, index }))
    .sort((a, b) => b.scan.timestamp - a.scan.timestamp || b.index - a.index)
    .map(({ scan }) => {
      const staged = laserStage(scan.code, scan.description);
      return { time: scan.time, description: scan.description, ...(scan.code ? { provider_code: scan.code } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    });
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const weight = Number(waybill.weight);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' && waybill.delivered ? { delivered_at: waybill.delivered } : {}),
    ...(waybill.weight && Number.isFinite(weight) && weight > 0 ? { weight_kg: weight } : {}),
    ...(waybill.service ? { service_name: waybill.service } : {}),
    destination_country: 'ZA',
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
