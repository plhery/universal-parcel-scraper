import { isPolonezReference } from '../../core/detection/polonez.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Polonez';
export const POLONEZ_MAX_BYTES = 1_000_000;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const PARTNER = /^Transferred to Final Destination\. GLS tracking number: ([0-9]{11})\s*$/i;

export function normalizePolonezNumber(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 64 || !/^[A-Z0-9]{4,40}$/.test(normalizeTrackingNumber(raw))) {
    throw new InvalidInputError(PROVIDER, 'Polonez needs a tracking label');
  }
  if (!isPolonezReference(raw)) throw new NoHistoryError(PROVIDER, 'This label is outside the verified Polonez guest route', { reason: 'unsupported_reference' });
  return normalizeTrackingNumber(raw);
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter(child => child.name === name && !child.uri);
}
function one(node: XmlNode, name: string): XmlNode {
  const found = children(node, name);
  if (found.length !== 1) throw new SchemaError(PROVIDER, `Polonez returned no unique ${name}`);
  return found[0]!;
}
function field(node: XmlNode, name: string): string {
  const found = children(node, name);
  if (found.length > 1 || found[0]?.children.length) throw new SchemaError(PROVIDER, 'Polonez returned a malformed tracking field');
  return found[0]?.text.trim() ?? '';
}
function clock(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: ([01]\d|2[0-3]):([0-5]\d):([0-5]\d))?$/.exec(raw);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) throw new SchemaError(PROVIDER, 'Polonez returned an invalid scan clock');
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return !match[4] || (match[4] === '00' && match[5] === '00' && ['00', '01'].includes(match[6]!))
    ? day : `${day}T${match[4]}:${match[5]}:${match[6]}`;
}
function plain(raw: string): string {
  if (raw.length > 2000) throw new SchemaError(PROVIDER, 'Polonez returned an oversized scan field');
  return textFromHtml(raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>'), 500).trim();
}
function wording(raw: string, finalLeg: boolean, originWarehouse: boolean): string {
  const text = raw.toLowerCase().replace(/\.+\s*$/, '').replace(/\s+/g, ' ').trim();
  if (text === 'shipper created a label, ups has not received the package yet') return 'Label created';
  if (text === 'received at authorized shipping outlet') return 'Received at authorized shipping outlet';
  if (text === 'on the way to the origin facility' || text === 'in transit') return 'In transit';
  if (text === 'arrived at facility') return 'Arrived at facility';
  if (text === 'departed from facility') return 'Departed from facility';
  if (text === 'processing at ups facility') return 'Processing at origin facility';
  if (['loaded on delivery vehicle', 'out for delivery today'].includes(text)) return finalLeg ? 'Out for delivery' : 'On delivery route to origin warehouse';
  if (text === 'receiving in port reading, nj, usa') return 'Received at origin warehouse';
  if (text === 'added to container') return 'Added to container';
  if (text === 'loaded into the ocean container') return 'Loaded into ocean container';
  if (text === 'shipped from new jersey, usa') return 'Shipped from origin warehouse';
  if (/^on the way to the destination facility in pl \(ocean container\)(?: \*)?$/.test(text)) return 'In transit to destination country';
  if (text === 'delivered to eu distribution center') return 'Arrived at EU distribution center';
  if (PARTNER.test(raw)) return 'Transferred to final-mile carrier';
  if (text === 'cleared customs - preparing for loading') return 'Customs cleared; preparing for loading';
  if (text === 'the parcel data was entered into the gls it system; the parcel was not yet handed over to gls') return 'Final-mile information received';
  if (text === 'the parcel was handed over to gls') return 'Handed over to final-mile carrier';
  if (text === 'the parcel has reached the parcel center') return 'Arrived at parcel center';
  if (text === 'the parcel is expected to be delivered during the day') return 'Delivery expected today';
  if (/^(?:delivered|the parcel has been delivered|doręczona - \d{4}-\d{2}-\d{2})$/.test(text)) {
    return finalLeg ? 'Delivered' : originWarehouse ? 'Delivered to origin warehouse' : 'Tracking update';
  }
  return 'Tracking update';
}
function place(city: string, country: string): string | undefined {
  const safe = city && city.length <= 80 && /^[\p{L}\p{M} ,.'’-]+$/u.test(city) && !/^(?:on the truck|on the ship)$/i.test(city) ? city : '';
  const nation = country === 'PL' ? 'Poland' : country === 'US' ? 'United States' : '';
  return [safe, nation].filter(Boolean).join(', ') || undefined;
}

/** The shared portal keeps every row under Polonez's own printed label. */
export function parsePolonez(xml: string, raw: string): CarrierResult {
  const number = normalizePolonezNumber(raw);
  const root = xmlDocument(xml, POLONEZ_MAX_BYTES);
  if (!root || root.name !== 'return' || root.uri) throw new SchemaError(PROVIDER, 'Polonez returned an unexpected reply');
  const errors = one(root, 'errors');
  const code = field(errors, 'code');
  if (!/^\d{1,6}$/.test(code)) throw new SchemaError(PROVIDER, 'Polonez returned no result code');
  if (code !== '000') throw new IndeterminateError(PROVIDER, 'The guest tracker did not complete its lookup');
  const table = one(root, 'result_table');
  const items = children(table, 'items');
  if (items.length !== table.children.length || items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Polonez returned an invalid history table');
  // Meest purges histories; an empty table is not proof the label never existed.
  if (!items.length) throw new IndeterminateError(PROVIDER, 'The guest tracker has no retained history for this label');
  const rows = items.map((row, index) => {
    const own = ['ShipmentNumber', 'ShipmentNumberSender', 'Barcode'].map(key => returnedTrackingNumber(field(row, key)));
    // Sender references and final-mile numbers do not establish Polonez label ownership.
    if (own.some(value => value !== number)) throw new SchemaError(PROVIDER, 'Polonez answered for another shipment');
    one(row, 'StatusCode');
    if (field(row, 'StatusCode')) throw new IndeterminateError(PROVIDER, 'The shared portal returned another service layout');
    const text = plain(field(row, 'ActionMessages_EN'));
    const city = field(row, 'City_EN');
    const country = field(row, 'Country_EN');
    const partner = PARTNER.exec(text)?.[1];
    const destination = field(row, 'CountryDel');
    return { index, local: clock(field(row, 'DateTimeAction')), text, city, country, partner,
      destination: /^[A-Z]{2}$/.test(destination) ? destination : '' };
  });
  for (let i = 1; i < rows.length; i += 1) {
    const previous = rows[i - 1]!.local, current = rows[i]!.local;
    if (current < previous && (current.slice(0, 10) !== previous.slice(0, 10) || (current.length > 10 && previous.length > 10))) {
      throw new SchemaError(PROVIDER, 'Polonez changed the source history order');
    }
  }
  const partners = new Set(rows.map(row => row.partner).filter(Boolean));
  if (partners.size > 1) throw new SchemaError(PROVIDER, 'Polonez returned conflicting final-mile labels');
  const firstHandoff = rows.findIndex(row => row.partner);
  const seen = new Set<string>();
  const shown = rows.map(row => {
    const finalLeg = firstHandoff >= 0 && row.index >= firstHandoff;
    const description = wording(row.text, finalLeg, /^port reading$/i.test(row.city));
    const stage = statusMap.stage(null, description);
    const location = place(row.city, row.country);
    const event: CarrierEvent = { local_time: row.local, description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return { ...row, event, stage };
  }).filter(row => {
    const key = JSON.stringify(row.event);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  shown.sort((a, b) => b.local.localeCompare(a.local) || b.index - a.index);
  const newest = shown[0]!;
  const stage = shown.find(row => row.stage)?.stage;
  const partner = [...partners][0];
  const destinations = new Set(rows.map(row => row.destination).filter(Boolean));
  if (destinations.size > 1) throw new SchemaError(PROVIDER, 'Polonez returned conflicting destinations');
  const statedDestination = [...destinations][0];
  const finalCountries = new Set(rows.filter(row => firstHandoff >= 0 && row.index >= firstHandoff).map(row => row.country).filter(Boolean));
  const polishDelivery = statedDestination ? statedDestination === 'PL' : finalCountries.size === 1 && finalCountries.has('PL');
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.event.description ?? null, last_update: null, last_update_local: newest.local,
    expected_delivery: null, events: shown.slice(0, MAX_EVENTS).map(row => row.event),
    ...(shown.length > MAX_EVENTS || shown.some(row => row.event.description === 'Tracking update') ? { history_truncated: true } : {}),
    ...(partner && polishDelivery ? { delivery_carrier: 'gls-pl', delivery_tracking_number: partner } : {}) };
}
