import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isOmLogisticsReference } from '../../core/detection/omLogistics.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { omStage } from './status.js';

export const PROVIDER = 'Om Logistics';
export const OM_MAX_BYTES = 512 * 1024;

export function normalizeOmNumber(raw: string): string {
  const number = raw.trim();
  if (!isOmLogisticsReference(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

export function omJson(raw: string): JsonObject {
  if (/<(?:html|script)\b|cf-chl-|captcha-container|Access Denied/i.test(raw)) {
    throw new ChallengeError(PROVIDER, 'Om Logistics returned a verification page');
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SchemaError(PROVIDER, 'Om Logistics returned unreadable JSON'); }
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Om Logistics changed its tracking envelope');
  if (typeof value.message === 'string' && /captcha/i.test(value.message)) {
    throw new ChallengeError(PROVIDER, 'Om Logistics rejected its verification code', { reason: 'verification_rejected' });
  }
  return value;
}

/** The official image is an SVG with five positioned text glyphs. No raster OCR or guessing. */
export function omChallenge(value: JsonObject): string {
  if (typeof value.image !== 'string' || value.image.length > 32_768 || !value.image.startsWith('data:image/svg+xml;utf8,')) {
    throw new ChallengeError(PROVIDER, 'Om Logistics changed its verification image');
  }
  let svg: string;
  try { svg = decodeURIComponent(value.image.slice('data:image/svg+xml;utf8,'.length)); }
  catch { throw new ChallengeError(PROVIDER, 'Om Logistics returned an unreadable verification image'); }
  const $ = load(svg, { xmlMode: true });
  const glyphs = $('svg > text').toArray().map(node => ({ x: Number($(node).attr('x')), text: $(node).text() }));
  if ($('svg').length !== 1 || $('text').length !== 5 || glyphs.length !== 5
    || glyphs.some(g => !Number.isFinite(g.x) || !/^[A-Za-z0-9]$/.test(g.text))
    || new Set(glyphs.map(g => g.x)).size !== 5) throw new ChallengeError(PROVIDER, 'Om Logistics verification is not readable uniquely');
  return glyphs.sort((a, b) => a.x - b.x).map(g => g.text).join('');
}

export function omSummary(value: JsonObject, raw: string): JsonObject {
  const number = normalizeOmNumber(raw);
  // The same bare error flag is not a contractual missing-shipment response.
  if (value.error === true) throw new IndeterminateError(PROVIDER, 'Om Logistics returned no confirmed shipment');
  if (value.error !== false || !Array.isArray(value.cn_enquiry) || value.cn_enquiry.length !== 1 || !isRecord(value.cn_enquiry[0])) {
    throw new SchemaError(PROVIDER, 'Om Logistics did not return one shipment');
  }
  const row = value.cn_enquiry[0];
  const identities = [row.CNNO, row.CNNNO].filter(x => x !== null && x !== undefined && x !== '');
  if (!identities.length || identities.some(x => typeof x !== 'string' || x.trim() !== number)) {
    throw new IndeterminateError(PROVIDER, 'Om Logistics answered for another shipment');
  }
  return row;
}

function clock(value: unknown): string {
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, 'Om Logistics omitted a scan date');
  const match = /^(\d{2})-([A-Z]{3})-(\d{2}|\d{4})(?: (\d{2}):(\d{2})(AM|PM))?$/.exec(value.trim().toUpperCase());
  if (!match) throw new SchemaError(PROVIDER, 'Om Logistics changed its scan date');
  const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(match[2]!) + 1;
  const year = match[3]!.length === 2 ? 2000 + +match[3]! : +match[3]!;
  if (!month || year < 2000 || year > 2099 || (match[4] && (+match[4] < 1 || +match[4] > 12))) {
    throw new SchemaError(PROVIDER, 'Om Logistics returned an invalid scan date');
  }
  const hour = match[4] ? +match[4] % 12 + (match[6] === 'PM' ? 12 : 0) : 0;
  const date = DateTime.fromObject({ year, month, day: +match[1]!, hour, minute: +(match[5] ?? 0) }, { zone: 'UTC' });
  if (!date.isValid) throw new SchemaError(PROVIDER, 'Om Logistics returned an invalid scan date');
  return date.toFormat(match[4] ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
}

export function parseOm(summary: JsonObject, history: JsonObject, raw: string): CarrierResult {
  const row = omSummary(summary, raw);
  if (history.error === true) throw new IndeterminateError(PROVIDER, 'Om Logistics could not supply its dispatch history');
  if (history.error !== false || !Array.isArray(history.cn_enquiry_detail) || history.cn_enquiry_detail.length > 500) {
    throw new SchemaError(PROVIDER, 'Om Logistics changed its dispatch history');
  }
  const events: CarrierEvent[] = [];
  const add = (value: unknown, description: string, stage: Stage, location?: string) => {
    events.push({ local_time: clock(value), description, stage, stage_source: 'carrier_map', ...(location ? { location } : {}) });
  };
  for (const scan of history.cn_enquiry_detail) {
    if (!isRecord(scan)) throw new SchemaError(PROVIDER, 'Om Logistics returned an invalid dispatch row');
    const source = clean(scan.SOURCE, 180), destination = clean(scan.DESTINATION, 180);
    if (/^DELIVERED ON-\d{2}-[A-Z]{3}-\d{4}$/i.test(destination)) {
      add(scan.OUT_DATE, destination, omStage(destination)!);
    } else if (destination.toUpperCase() === 'OUT FOR DELIVERY') {
      add(scan.OUT_DATE, destination, omStage(destination)!, source || undefined);
    } else if (/^BOOKED FROM-./i.test(source) && !destination) {
      add(scan.OUT_DATE, source, omStage(source)!, source.replace(/^BOOKED FROM-/i, ''));
    } else if (source && destination) {
      // OUT_DATE and ARRIVAL_ENTRY are distinct carrier-labelled dispatch clocks.
      // Emit arrival first to retain the API's newest-first sequence.
      if (scan.ARRIVAL_ENTRY) add(scan.ARRIVAL_ENTRY, `Arrival Entry: ${source} → ${destination}`, 'in_transit', destination);
      add(scan.OUT_DATE, `Out Date: ${source} → ${destination}`, 'in_transit', source);
    } else throw new SchemaError(PROVIDER, 'Om Logistics returned an unrecognised dispatch row');
  }
  const unique = events.filter((event, index) => events.findIndex(other => JSON.stringify(other) === JSON.stringify(event)) === index);
  if (!unique.length) throw new NoHistoryError(PROVIDER);
  const latest = unique[0]!;
  const service = clean(row.BOOKING_MODE, 80);
  return { status: languageStageStatus(latest.stage as Stage), current_stage: latest.stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time, expected_delivery: null,
    ...(service ? { service_name: service } : {}), events: unique };
}
