import { DateTime } from 'luxon';
import { isValidDpdParcelNumber } from '../../core/detection/dpd.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { chronopostStage, isChronopostNotification } from './status.js';

export const CHRONOPOST_MAX_BYTES = 2_000_000;
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
export const CHRONOPOST_NAMESPACE = 'http://cxf.tracking.soap.chronopost.fr/';
const MAX_EVENTS = 500;

export function normalizeChronopostNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(value) && !isValidDpdParcelNumber(value)) {
    throw new InvalidInputError('Chronopost', 'Chronopost requires a postal-shaped identifier or a checked 15-character parcel number');
  }
  return value;
}

function children(node: XmlNode, name: string, uri = ''): XmlNode[] {
  return node.children.filter(child => child.name === name && child.uri === uri);
}

function one(node: XmlNode, name: string, uri = ''): XmlNode {
  const found = children(node, name, uri);
  if (found.length !== 1) throw new SchemaError('Chronopost', 'Chronopost returned an invalid tracking structure');
  return found[0]!;
}

function scalar(node: XmlNode, name: string, required = false): string {
  const found = children(node, name);
  if (found.length > 1 || found[0]?.children.length || (required && found.length !== 1)) {
    throw new SchemaError('Chronopost', 'Chronopost returned an invalid tracking field');
  }
  return found[0]?.text.trim() ?? '';
}

function clock(raw: string): { time?: string; local_time?: string; provider_time_text?: string } {
  // Reject impossible offsets that Luxon otherwise normalizes.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(raw)) {
    const parsed = explicitOffsetTime(raw);
    if (parsed) return { time: parsed.iso };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw) && DateTime.fromISO(raw, { zone: 'UTC' }).isValid) {
    return { local_time: raw };
  }
  return raw ? { provider_time_text: clean(raw, 64) } : {};
}

/** The recipient's chosen redelivery day, printed as dd/MM/yyyy. */
function redeliveryDay(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** The calendar day of a scan's own clock, or '' without one. */
const clockDay = (event: CarrierEvent) => {
  const clock = event.time ?? event.local_time;
  return typeof clock === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(clock)?.[0] ?? '' : '';
};

/** Stages on the way to a planned delivery. */
const ONGOING = new Set<Stage>(['pending', 'registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery']);

/** Keep operational places, never the delivery-point address or shop contact block. */
function location(office: string, place: string): string {
  if (/^[\p{L}\p{M} .,'’()-]{1,100} - [A-Z]{2}(?: \(depot \d{1,6}\))?$/u.test(place)) return place;
  const shop = /^([\p{L}\p{M} .,'’-]{1,100}) - ([A-Z]{2}) - /u.exec(office);
  if (shop) return `${shop[1]}, ${shop[2]}`;
  return /^[\p{L}\p{M} .,'’()/-]{1,160}$/u.test(office) ? office : '';
}

export function parseChronopostTrackingXml(xml: string, rawNumber: string): CarrierResult {
  const requested = normalizeChronopostNumber(rawNumber);
  const root = xmlDocument(xml, CHRONOPOST_MAX_BYTES);
  if (!root || root.name !== 'Envelope' || root.uri !== SOAP) {
    if (/<title>\s*Just a moment|cf-chl-|challenge-platform/i.test(xml)) throw new ChallengeError('Chronopost');
    throw new SchemaError('Chronopost', 'Chronopost returned invalid tracking XML');
  }
  const body = one(root, 'Body', SOAP);
  if (children(body, 'Fault', SOAP).length) throw new IndeterminateError('Chronopost', 'Chronopost tracking returned a SOAP fault');
  if (body.children.length !== 1) throw new SchemaError('Chronopost', 'Chronopost returned ambiguous tracking results');
  const response = one(body, 'trackSkybillV2Response', CHRONOPOST_NAMESPACE);
  const result = one(response, 'return');
  const errorCode = scalar(result, 'errorCode', true);
  if (!/^\d+$/.test(errorCode)) throw new SchemaError('Chronopost', 'Chronopost returned an invalid tracking error code');
  if (Number(errorCode) !== 0) throw new IndeterminateError('Chronopost', 'Chronopost tracking is unavailable');
  const history = one(result, 'listEventInfoComp');
  // Compare the entire identity, without truncation or accepting a linked parcel as an alias.
  const identity = scalar(history, 'skybillNumber', true).toUpperCase().replace(/[\s.-]/g, '');
  if (identity !== requested) {
    throw new SchemaError('Chronopost', 'Chronopost returned a different shipment');
  }
  const scans = children(history, 'events');
  if (!scans.length) throw new NotFoundError('Chronopost');
  if (scans.length > MAX_EVENTS) throw new SchemaError('Chronopost', 'Chronopost returned excessive tracking history');

  const references = new Set<string>();
  const geoReferences = new Set<string>();
  const destinations = new Set<string>();
  const projected = scans.map((scan, index) => {
    const description = clean(scalar(scan, 'eventLabel', true), 500);
    const code = clean(scalar(scan, 'code'), 40);
    if (!description) throw new SchemaError('Chronopost', 'Chronopost returned an empty tracking event');
    const extras = children(scan, 'infoCompList');
    let place = '';
    let redelivery: string | null | undefined;
    for (const extra of extras) {
      const name = scalar(extra, 'name');
      const value = scalar(extra, 'value');
      if (name === 'Lieu') place = value;
      if (name === 'Date de relivraison') redelivery = redeliveryDay(value);
      if (name === 'Numéro partenaire') {
        const match = /^(?:GEO\/)?([A-Z0-9]{4,40})$/.exec(value.toUpperCase());
        if (match) {
          references.add(match[1]!);
          if (value.toUpperCase().startsWith('GEO/') && isValidDpdParcelNumber(match[1]!)) geoReferences.add(match[1]!);
        }
      }
      if (name === 'Point de livraison') {
        // Only the terminal country is projected; discard the address itself.
        const country = countryCode(/ - ([A-Z]{2})$/.exec(value)?.[1]);
        if (country) destinations.add(country);
      }
    }
    const event: CarrierEvent = {
      ...clock(scalar(scan, 'eventDate')),
      description,
      location: location(scalar(scan, 'officeLabel'), place),
      ...(code ? { provider_code: code } : {}),
    };
    const mapped = chronopostStage(code, description);
    return { event, mapped, notification: isChronopostNotification(description), index, redelivery };
  });
  // The operation returns oldest first. Reorder only when all scan clocks
  // establish instants, so mixed local clocks cannot create a guessed order.
  if (projected.every(scan => explicitOffsetTime(scan.event.time))) {
    projected.sort((left, right) => explicitOffsetTime(left.event.time)!.timestamp
      - explicitOffsetTime(right.event.time)!.timestamp || left.index - right.index);
  }
  let stage: Stage = 'pending';
  let stageSource = 'none';
  for (const scan of projected) {
    if (!scan.notification && scan.mapped.source !== 'none') {
      stage = scan.mapped.stage;
      stageSource = scan.mapped.source;
    }
    // An alert records activity, but does not regress delivery or prove movement.
    scan.event.stage = scan.notification ? stage : scan.mapped.stage;
    scan.event.stage_source = scan.notification ? 'none' : scan.mapped.source;
  }
  // The newest instruction that names a redelivery day decides, even when its
  // day is unreadable. A later scan that is not progress towards that delivery,
  // or that falls on a later day, ends it.
  let promised: string | null = null;
  for (const scan of projected) {
    if (scan.redelivery !== undefined) promised = scan.redelivery;
    else if (promised && (clockDay(scan.event) > promised || (!scan.notification && !ONGOING.has(scan.mapped.stage)))) {
      promised = null;
    }
  }
  const events = projected.reverse().slice(0, 100).map(scan => scan.event);
  const latest = events[0]!;
  const reference = references.size === 1 ? [...references][0] : undefined;
  const destination = destinations.size === 1 ? [...destinations][0] : undefined;
  // The typed Geopost reference and Germany destination propose a national
  // lookup. The downstream adapter must still confirm ownership and activity.
  const partner = reference && geoReferences.has(reference) && destination === 'DE' ? 'dpd-de' : undefined;
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: stageSource,
    last_status_text: latest.description,
    last_update: latest.time ?? null,
    expected_delivery: ['delivered', 'returned', 'ready_for_pickup'].includes(stage) ? null : promised,
    ...(reference ? { delivery_tracking_number: reference } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
