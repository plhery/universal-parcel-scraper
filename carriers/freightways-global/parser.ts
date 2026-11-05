import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isFreightwaysGlobalReference } from '../../core/detection/freightwaysGlobal.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { freightwaysGlobalStage } from './status.js';

export const PROVIDER = 'Freightways Global';
export function normalizeFreightwaysGlobalNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Freightways Global needs a parcel reference');
  if (!isFreightwaysGlobalReference(number)) throw new NoHistoryError(PROVIDER, 'The guest route does not support this reference', { reason: 'unsupported_reference' });
  return number;
}
export function freightwaysGlobalUrl(number: string): string {
  // The account is already in the caller's reference; restore only its separator.
  const value = normalizeFreightwaysGlobalNumber(number).replace(/^(\d+)(NZC\d{9})$/, '$1-$2');
  return `https://track.fgmailconnect.co.nz/?${new URLSearchParams({ id: value })}`;
}
function wording(value: string): string {
  const text = clean(value, 1000).split(/https?:\/\/|\b(?:recipient|consignee|signed by|phone)\s*[:：]?/i, 1)[0]!.trim();
  if (!text || /[<>@]|\d{7,}/.test(text)) throw new SchemaError(PROVIDER, 'Freightways Global returned no logistics description');
  return text;
}
function place(value: string): string {
  const text = clean(value, 250);
  return /[<>@]|https?:|\d{5,}|\b(?:phone|street|road|avenue|apartment|address)\b/i.test(text) ? '' : text;
}
export function parseFreightwaysGlobal(html: string, raw: string): CarrierResult {
  const number = normalizeFreightwaysGlobalNumber(raw), $ = load(html); $('script,style,template').remove();
  const headings = $('h3').filter((_, el) => /^Tracking:/.test($(el).text().trim()));
  const allText = $.root().text();
  if (!headings.length && /No results found\b/.test(allText)) {
    if ($('table tbody tr').length) throw new SchemaError(PROVIDER, 'Freightways Global mixed absence with a history');
    // The tracker no longer retains old consignments; this is not proof of an invalid parcel.
    throw new NoHistoryError(PROVIDER, 'The guest route has no retained shipment', { reason: 'expired_or_unknown' });
  }
  if (headings.length !== 1 || /No results found\b/.test(allText)) throw new SchemaError(PROVIDER, 'Freightways Global returned no unique shipment');
  const fact = (label: string): string => {
    const key = $('strong').filter((_, el) => $(el).text().trim() === label);
    const value = key.parent().next('div.col-md-3');
    if (key.length !== 1 || !key.parent().hasClass('col-md-3') || value.length !== 1 || value.find('strong').length) throw new SchemaError(PROVIDER, 'Freightways Global changed its shipment facts');
    return value.html() ?? '';
  };
  const lines = fact('Tracking No').split(/<br\s*\/?\s*>/i).map(part => clean(load(part).text(), 200)).filter(Boolean);
  if (lines.length > 20) throw new SchemaError(PROVIDER, 'Freightways Global returned too many identities');
  const labels = lines.filter(value => /^NZC\d{9}$/.test(value)), gss = lines.filter(value => /^GSS\d{6,20}$/.test(value));
  const accounts = lines.filter(value => /^\d{1,12}-NZC\d{9}$/.test(value));
  if (labels.length !== 1 || gss.length !== 1 || accounts.length !== 1 || accounts[0]!.split('-')[1] !== labels[0]) throw new SchemaError(PROVIDER, 'Freightways Global returned ambiguous shipment identities');
  const identities = [labels[0]!, gss[0]!, accounts[0]!].map(normalizeTrackingNumber);
  const header = normalizeTrackingNumber(clean(headings.text().replace(/^\s*Tracking:\s*/, ''), 64));
  if (!identities.includes(number) || !identities.includes(header)) throw new SchemaError(PROVIDER, 'Freightways Global returned another shipment');
  if (!lines.includes('IsFGInternational')) throw new NoHistoryError(PROVIDER, 'The portal did not identify its international forwarding service', { reason: 'unsupported_service' });
  const piecesText = clean(load(fact('Total Pieces')).text(), 20);
  if (!/^[1-9]\d{0,2}$/.test(piecesText)) throw new SchemaError(PROVIDER, 'Freightways Global returned an invalid parcel count');
  const pieces = Number(piecesText);
  if (pieces !== 1) throw new NoHistoryError(PROVIDER, 'The verified guest scope is a single-parcel import', { reason: 'unsupported_service' });
  const tables = $('table').filter((_, el) => clean($(el).find('thead').text()) === 'Date/Time Activity Location Carrier');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Freightways Global returned no unique history');
  const rows = tables.find('tbody').children('tr');
  if (rows.length > 1000) throw new SchemaError(PROVIDER, 'Freightways Global returned too many history rows');
  const events: CarrierEvent[] = [], seen = new Set<string>(); let day = '', scans = 0, clearance = false, handover = false;
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length === 1 && cells.attr('colspan') === '5') {
      const date = DateTime.fromFormat(clean(cells.text(), 80), 'cccc, d LLLL yyyy', { locale: 'en', zone: 'UTC' });
      if (!date.isValid) throw new SchemaError(PROVIDER, 'Freightways Global returned an invalid history day');
      day = date.toISODate()!; continue;
    }
    if (cells.length !== 5) throw new SchemaError(PROVIDER, 'Freightways Global changed its history columns');
    if ($(row).hasClass('detaillines')) {
      const detail = clean(cells.eq(1).text(), 100), match = /^(NZC\d{9})(\d{2}) \(Parcel# ([1-9]\d{0,2})\)$/.exec(detail);
      if (!match || match[1] !== labels[0] || Number(match[2]) !== Number(match[3]) || Number(match[3]) > pieces
        || [0, 2, 3, 4].some(index => clean(cells.eq(index).text()))) throw new SchemaError(PROVIDER, 'Freightways Global returned another parcel in its details');
      continue;
    }
    if (++scans > 500 || !day || !cells.eq(1).hasClass('time')) throw new SchemaError(PROVIDER, 'Freightways Global returned an invalid scan');
    const time = DateTime.fromFormat(`${day} ${clean(cells.eq(1).text(), 32)}`, 'yyyy-MM-dd h:mm a', { locale: 'en', zone: 'UTC' });
    if (!time.isValid) throw new SchemaError(PROVIDER, 'Freightways Global returned an invalid local clock');
    const description = wording(cells.eq(2).text()), stage = freightwaysGlobalStage(null, description), location = place(cells.eq(3).text());
    clearance ||= description === 'Customs cleared in NZ'; handover ||= description === 'Handed over to final mile carrier.';
    const event: CarrierEvent = { local_time: time.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event); if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Freightways Global returned no dated history');
  if (!clearance || !handover) throw new NoHistoryError(PROVIDER, 'The portal did not show its own inbound forwarding leg', { reason: 'unsupported_service' });
  const newest = events[0]!, stage = freightwaysGlobalStage(null, newest.description!);
  const service = clean(load(fact('Service')).text(), 80), mass = clean(load(fact('Total Weight')).text(), 40);
  if (!service || /[<>@]|https?:|\d{7,}/.test(service)) throw new SchemaError(PROVIDER, 'Freightways Global returned an invalid service');
  const weight = /^(\d+(?:\.\d+)?) Kg$/.exec(mass);
  if (!weight || Number(weight[1]) > 1_000_000) throw new SchemaError(PROVIDER, 'Freightways Global returned an invalid mass');
  // Detail-row barcodes require a sender account at NZ Couriers. They are not bare guest lookup references.
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    service_name: service, weight_kg: Number(weight[1]), destination_country: 'NZ',
    ...(number !== labels[0] ? { canonical_tracking_number: labels[0] } : {}),
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
