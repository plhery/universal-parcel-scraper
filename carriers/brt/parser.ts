import { load, type CheerioAPI } from 'cheerio';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { isBrtTrackingNumber } from '../../core/detection/brt.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { classifyBrtStatus } from './status.js';

export function normalizeBrtNumber(raw: string): string {
  const number = raw.replace(/\s/g, '');
  if (!isBrtTrackingNumber(number)) {
    throw new InvalidInputError('BRT', 'BRT requires a twelve-digit shipment number, fourteen-digit BRTcode or fifteen-digit parcel ID');
  }
  return number;
}

/** A fifteen-digit BRT parcel ID ("ID collo"), searched through the form's customer parcel ID route. */
export function isBrtParcelId(number: string): boolean {
  return /^\d{15}$/.test(number);
}

/** The label in a table's first cell of a row, as BRT prints it. */
function rowLabel($: CheerioAPI, row: Parameters<CheerioAPI>[0]): string {
  return clean($(row).children('td').first().text(), 40);
}

/**
 * The shipment's own detail table. A held parcel ("giacenza") adds a second
 * table of the same class, headed by its storage number, which is not shipment
 * identity.
 */
function shipmentTables($: CheerioAPI) {
  return $('table.table_dati_spedizione').filter((_, table) =>
    $(table).find('tr').toArray().some((row) => ['N. spedizione', 'BRTcode'].includes(rowLabel($, row))));
}

/**
 * The scan table, with its four columns. A shipment handed to DPD abroad adds a
 * two-column link box of the same class, which is not history.
 */
function scanTables($: CheerioAPI) {
  return $('table.table_stato_dati').filter((_, table) => $(table).find('tr').first().children('td, th').length === 4);
}

/**
 * The link from a parcel-ID result to its list of parcels, which names each
 * parcel's BRT and customer IDs. Only a relative link to that list for the
 * same shipment is followed.
 */
export function brtParcelListPath(html: string): string {
  const $ = load(html);
  const shipments = shipmentTables($);
  // "Shipment not found or still being processed": the search covers two months.
  if (!shipments.length && !scanTables($).length) throw new IndeterminateError('BRT', 'BRT did not return shipment history');
  const shipment = shipments.length === 1
    ? shipments.find('tr').filter((_, row) => rowLabel($, row) === 'N. spedizione').children('td').last().text()
    : '';
  const href = $('a#aColli').attr('href') ?? '';
  const url = /^sped_colli_lista\.htm\?[^#\s]*$/.test(href) ? new URL(href, 'https://vas.brt.it/vas/') : null;
  if (!url || !/^\d{12}$/.test(clean(shipment, 20)) || url.searchParams.get('nspediz') !== clean(shipment, 20)) {
    throw new SchemaError('BRT', 'BRT returned no parcel list for the parcel ID');
  }
  url.searchParams.set('lang', 'en');
  return `${url.pathname}${url.search}`;
}

/** Whether BRT's parcel list for the shipment names the requested parcel ID. */
export function brtParcelListNames(html: string, number: string): boolean {
  const $ = load(html);
  const tables = $('table.table_spedizione').filter((_, table) =>
    $(table).find('tr').first().children('td, th').map((__, node) => clean($(node).text(), 40)).get().join('|') === 'ID collo BRT|ID collo cliente');
  if (tables.length !== 1) throw new SchemaError('BRT', 'BRT parcel list changed');
  const rows = tables.find('tr').slice(1).toArray();
  if (rows.length === 0 || rows.length > 500) throw new SchemaError('BRT', 'BRT parcel list changed');
  return rows.some((row) => $(row).children('td').toArray().some((cell) => clean($(cell).text(), 40) === number));
}

function scanClock(date: string, clock: string): { local_time?: string; provider_time_text?: string } {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  const day = match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  const time = /^(\d{2})\.(\d{2})$/.exec(clock);
  if (day && time && Number(time[1]) < 24 && Number(time[2]) < 60) {
    return { local_time: `${day}T${time[1]}:${time[2]}:00` };
  }
  const raw = clean(`${date} ${clock}`, 64);
  return raw ? { provider_time_text: raw } : {};
}

/**
 * Projects one BRT detail page. A parcel ID's page does not repeat the ID, so
 * it is only read together with the shipment's parcel list naming that ID.
 */
export function parseBrt(html: string, raw: string, parcelList?: string): CarrierResult {
  const number = normalizeBrtNumber(raw);
  const $ = load(html);
  const metadata = shipmentTables($);
  const history = scanTables($);
  if (!metadata.length && !history.length) {
    const scope = $('#box_tool_content');
    const heading = scope.children('h3.separatore');
    const errors = scope.children('#box_contenuti').clone();
    errors.find('script, style').remove();
    if (number.length === 14 && scope.length === 1 && errors.length === 1 && heading.length === 1 && clean(heading.text(), 80) === 'Errori riscontrati'
      && clean(errors.text(), 300) === `TIS0868 Parcel Label number ${number} not found`) {
      throw new NotFoundError('BRT');
    }
    throw new IndeterminateError('BRT', 'BRT did not return shipment history');
  }
  if (metadata.length !== 1 || history.length > 1) throw new SchemaError('BRT', 'BRT returned ambiguous shipment details');
  const parcelId = isBrtParcelId(number);
  const identityLabel = number.length === 14 ? 'BRTcode' : 'N. spedizione';
  const identityRows = metadata.find('tr').filter((_, node) => rowLabel($, node) === identityLabel);
  const identity = identityRows.children('td');
  const shown = clean(identity.last().text(), 40);
  if (identityRows.length !== 1 || identity.length !== 2
    || (parcelId ? !/^\d{12}$/.test(shown) || parcelList === undefined || !brtParcelListNames(parcelList, number) : shown !== number)) {
    throw new SchemaError('BRT', 'BRT returned a different or incomplete shipment');
  }
  if (!history.length) throw new IndeterminateError('BRT', 'BRT returned no tracking scans');
  const rows = history.find('tr');
  if (rows.length > 501) throw new SchemaError('BRT', 'BRT returned too many tracking scans');
  const header = rows.first().children('td, th').map((_, node) => clean($(node).text(), 40)).get();
  if (header.join('|') !== 'Data|Ora|Filiale|Evento') throw new SchemaError('BRT', 'BRT tracking columns changed');
  const events: CarrierEvent[] = [];
  for (const row of rows.slice(1).toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError('BRT', 'BRT returned an incomplete scan');
    const date = clean(cells.eq(0).text(), 40);
    const clock = clean(cells.eq(1).text(), 24);
    const location = clean(cells.eq(2).text(), 120);
    const label = clean(cells.eq(3).text(), 160);
    if (!label || !/^[\p{L}][\p{L}\p{N}\s().,'/-]{1,159}$/u.test(label)) throw new SchemaError('BRT', 'BRT returned an invalid scan label');
    const mapped = classifyBrtStatus(label);
    events.push({ description: mapped?.status === 'delivered' ? 'Delivered' : label, provider_status: label,
      ...(mapped ? { stage: mapped.stage } : {}), ...(location ? { location } : {}), ...scanClock(date, clock) });
  }
  if (!events.length) throw new IndeterminateError('BRT', 'BRT returned empty tracking history');
  // BRT includes cross-border depots without identifying each scan's zone.
  // Source order also carries undated scans, so local clocks are never sorted.
  const latest = events[0]!;
  let mapped = classifyBrtStatus(String(latest.provider_status));
  // A shipment sent back reads DELIVERED once it reaches its sender again.
  if (mapped?.stage === 'delivered' && events.slice(1).some((event) => event.stage === 'returned')) {
    mapped = { status: 'exception', stage: 'returned' };
  }
  const goodsRows = metadata.find('tr').filter((_, node) => rowLabel($, node) === 'Natura merce');
  const weightText = goodsRows.length === 1 ? clean(goodsRows.children('td').last().text(), 300) : '';
  const weightLabels = weightText.match(/\bPeso \(kg\):/g) ?? [];
  const weightMatch = /\bPeso \(kg\):\s*(\d+(?:[,.]\d{1,4})?)(?=\s+Volume\b|$)/.exec(weightText);
  const weight = weightLabels.length === 1 && weightMatch ? Number(weightMatch[1]!.replace(',', '.')) : NaN;
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    ...(Number.isFinite(weight) && weight > 0 && weight <= 100_000 ? { weight_kg: weight } : {}),
    events: events.slice(0, 100) };
}
