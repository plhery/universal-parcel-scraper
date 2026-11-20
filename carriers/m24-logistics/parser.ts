import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { m24Stage } from './status.js';

export const PROVIDER = 'm24-logistics';
// An order with a long history is a few tens of kilobytes.
export const M24_MAX_BYTES = 1_000_000;
// M24's scans are South Africa's, where it delivers.
const ZONE = 'Africa/Johannesburg';

// Order references, parcel and shipment numbers, invoice numbers and shops' references.
const NUMBER = /^[A-Z0-9][A-Z0-9-]{3,39}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?$/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenges\.cloudflare\.com|g-recaptcha|hcaptcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
/** Next's notFound() and redirect() travel as error rows, and mean the route changed. */
const NEXT_CONTROL = /^(?:NEXT_NOT_FOUND$|NEXT_HTTP_ERROR_FALLBACK;|NEXT_REDIRECT;)/;
const MAX_ORDERS = 50;
const MAX_PARCELS = 100;
const MAX_SCANS = 2_000;
const MAX_NODES = 200_000;
const MAX_DEPTH = 32;

/** The tracker no longer has the action the request named: it answered with its page, or with Next's reply for an unknown action. */
export class UnknownActionError extends SchemaError {
  constructor() {
    super(PROVIDER, 'M24 Logistics no longer knows the action asked: the tracking lookup changed');
    this.name = 'UnknownActionError';
  }
}

/** Whether a page is a CDN's or firewall's browser check. */
export function isChallengePage(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

/** A reference as the tracker takes it, which it reads without regard to case. */
export function normalizeM24Number(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Invalid M24 Logistics reference');
  return number;
}

// Row tags whose payload gives its length in bytes, as hex before a comma, and
// ends without a line feed: text, and typed arrays.
const LENGTH_TAGS = new Set([...'TAOoUSsLlGgMmV'].map(tag => tag.charCodeAt(0)));
const COLON = 0x3a;
const COMMA = 0x2c;
const LINE_FEED = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

type Row = { kind: 'json'; json: string } | { kind: 'text'; text: string } | { kind: 'error'; digest: string };

function decode(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'M24 Logistics returned an unreadable reply', { cause });
  }
}

function errorDigest(json: string): string {
  try {
    const error: unknown = JSON.parse(json);
    return isRecord(error) && typeof error.digest === 'string' ? error.digest : '';
  } catch {
    return '';
  }
}

/**
 * The rows of a React Server Components reply by id. A text row ends where its
 * byte length does, so rows are read by length, not split at line feeds. Hint
 * and module rows are skipped.
 */
function flightRows(bytes: Uint8Array): Map<string, Row> {
  const rows = new Map<string, Row>();
  let at = 0;
  while (at < bytes.length) {
    if (bytes[at] === LINE_FEED) { at += 1; continue; }
    const colon = bytes.indexOf(COLON, at);
    const id = colon < 0 ? '' : ascii(bytes.subarray(at, Math.min(colon, at + 9)));
    if (!/^[0-9a-f]{1,8}$/.test(id)) throw new SchemaError(PROVIDER, 'M24 Logistics returned an unreadable reply');
    at = colon + 1;
    if (LENGTH_TAGS.has(bytes[at]!)) {
      const comma = bytes.indexOf(COMMA, at);
      const length = comma < 0 ? '' : ascii(bytes.subarray(at + 1, Math.min(comma, at + 10)));
      if (!/^[0-9a-f]{1,8}$/.test(length)) throw new SchemaError(PROVIDER, 'M24 Logistics returned an unreadable reply');
      const end = comma + 1 + parseInt(length, 16);
      if (end > bytes.length) throw new SchemaError(PROVIDER, 'M24 Logistics returned a truncated reply');
      if (bytes[at] === 0x54) rows.set(id, { kind: 'text', text: decode(bytes.subarray(comma + 1, end)) });
      at = end;
      continue;
    }
    const end = bytes.indexOf(LINE_FEED, at);
    const stop = end < 0 ? bytes.length : end;
    const row = decode(bytes.subarray(at, stop));
    at = stop + 1;
    if (row.startsWith('E{')) rows.set(id, { kind: 'error', digest: errorDigest(row.slice(1)) });
    else if (/^(?:[[{"\d-]|null$|true$|false$)/.test(row)) rows.set(id, { kind: 'json', json: row });
  }
  return rows;
}

/** Any Flight value the parser never reads as data, such as a Date or a server reference. */
class Opaque {}

/** Flight values as plain ones: `$$` escapes a dollar, `$undefined` is absent, and `$` with a hex id refers to another row. */
function resolver(rows: Map<string, Row>) {
  let nodes = 0;
  const parsed = new Map<string, unknown>();
  const open = new Set<string>();
  const row = (id: string, depth: number): unknown => {
    const found = rows.get(id);
    if (!found || found.kind === 'error' || open.has(id)) throw new SchemaError(PROVIDER, 'M24 Logistics returned an unreadable reply');
    if (found.kind === 'text') return found.text;
    if (!parsed.has(id)) {
      try {
        parsed.set(id, JSON.parse(found.json));
      } catch (cause) {
        throw new SchemaError(PROVIDER, 'M24 Logistics returned an unreadable reply', { cause });
      }
    }
    open.add(id);
    try {
      return value(parsed.get(id), depth + 1);
    } finally {
      open.delete(id);
    }
  };
  const value = (node: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new SchemaError(PROVIDER, 'M24 Logistics returned an oversized reply');
    if (typeof node === 'string') {
      if (!node.startsWith('$')) return node;
      if (node.startsWith('$$')) return node.slice(1);
      if (node === '$undefined') return undefined;
      const reference = /^\$@?([0-9a-f]{1,8})$/.exec(node)?.[1];
      return reference === undefined ? new Opaque() : row(reference, depth);
    }
    if (Array.isArray(node)) return node.map((child: unknown) => value(child, depth + 1));
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = value(child, depth + 1);
      return out;
    }
    return node;
  };
  return row;
}

/** What the page's server action returned: row 0 names the row that holds it. A thrown action leaves an error row there. */
function actionResult(bytes: Uint8Array): unknown {
  const rows = flightRows(bytes);
  const head = rows.get('0');
  let target: string | undefined;
  try {
    const parsed: unknown = head?.kind === 'json' ? JSON.parse(head.json) : null;
    target = Array.isArray(parsed) && typeof parsed[0] === 'string' ? /^\$@([0-9a-f]{1,8})$/.exec(parsed[0])?.[1] : undefined;
  } catch {
    target = undefined;
  }
  if (target === undefined) throw new SchemaError(PROVIDER, 'M24 Logistics returned a reply without its lookup result');
  const found = rows.get(target);
  if (found?.kind === 'error') {
    if (NEXT_CONTROL.test(found.digest)) throw new SchemaError(PROVIDER, 'M24 Logistics redirected or dropped its order page');
    throw new IndeterminateError(PROVIDER, 'M24 Logistics could not complete the lookup');
  }
  return resolver(rows)(target, 0);
}

/**
 * The action's reply as a value. A page in its place is a browser check, or the
 * order page itself, which Next renders for an action it does not have.
 */
export function readActionReply(bytes: Uint8Array, contentType: string | null): unknown {
  if (!/^text\/x-component\b/i.test(contentType ?? '')) {
    const head = decode(bytes.subarray(0, 64_000));
    if (isChallengePage(head)) throw new ChallengeError(PROVIDER, 'M24 Logistics answered with a browser check');
    if (/^\s*</.test(head)) throw new UnknownActionError();
    throw new SchemaError(PROVIDER, 'M24 Logistics returned an unexpected reply');
  }
  return actionResult(bytes);
}

/** An optional text field; anything but a string is a changed reply. */
function text(record: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `M24 Logistics returned an invalid ${key}`);
  return clean(value, maxLength);
}

function list(record: Record<string, unknown>, key: string, max: number): Record<string, unknown>[] {
  const value = record[key];
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  if (items.length > max || !items.every(isRecord)) throw new SchemaError(PROVIDER, `M24 Logistics returned an invalid ${key}`);
  return items;
}

/** The references an order answers to: its own, the shop's, its invoice's, and its parcels'. */
function references(order: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const add = (value: unknown) => {
    const reference = typeof value === 'string' || typeof value === 'number' ? normalizeTrackingNumber(String(value)) : '';
    if (reference) found.add(reference);
  };
  for (const key of ['InvoiceNumber', 'CustomerReference', 'CustomerReference2', 'ShipmentID', 'AdditionalTrack']) add(order[key]);
  for (const parcel of list(order, 'Parcels', MAX_PARCELS)) {
    add(parcel.TrackingNumber);
    for (const stamp of list(parcel, 'ParcelBackstamps', MAX_PARCELS)) add(stamp.BackstampTrackingNumber);
  }
  return found;
}

/** A scan's clock: the wall clock M24 writes without a zone, read in South Africa's. */
function clock(value: unknown): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const wall = WALL_CLOCK.exec(typeof value === 'string' ? value : '');
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  // Luxon rolls an impossible clock over, so only one that reads back unchanged is kept.
  const checked = DateTime.fromISO(local, { zone: 'UTC' });
  const time = wall && checked.isValid && checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local ? isoTime(local, ZONE) : null;
  if (!time) throw new SchemaError(PROVIDER, 'M24 Logistics returned a scan without a readable clock');
  return { local_time: local, time: time.iso, time_zone: ZONE, time_zone_basis: 'carrier' };
}

function scan(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const id = row.ParcelStatus_ID;
  const code = typeof id === 'number' && Number.isInteger(id) ? String(id) : typeof id === 'string' && /^\d{1,9}$/.test(id) ? id : '';
  const description = text(row, 'StatusName');
  if (!code || !description) throw new SchemaError(PROVIDER, 'M24 Logistics returned a scan without a status');
  const when = clock(row.StatusDate);
  const staged = m24Stage(code, description);
  return {
    key: JSON.stringify([when.local_time, code, description]),
    event: { ...when, description, provider_code: code, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) },
  };
}

/** The order the reply holds for the reference: the one that answers to it. */
function orderFor(reply: unknown, number: string): Record<string, unknown> {
  if (!Array.isArray(reply)) {
    if (isRecord(reply) && clean(reply.ResponseMessage, 300)) {
      throw new IndeterminateError(PROVIDER, `M24 Logistics answered: ${clean(reply.ResponseMessage, 300)}`);
    }
    throw new SchemaError(PROVIDER, 'M24 Logistics returned an invalid order list');
  }
  // The order page reads an empty list as no order.
  if (!reply.length) throw new NotFoundError(PROVIDER);
  if (reply.length > MAX_ORDERS || !reply.every(isRecord)) throw new SchemaError(PROVIDER, 'M24 Logistics returned an invalid order list');
  const matching = (reply as Record<string, unknown>[]).filter(order => references(order).has(number));
  if (!matching.length) throw new IndeterminateError(PROVIDER, 'M24 Logistics answered for another order');
  if (new Set(matching.map(order => String(order.OrderId))).size > 1) {
    throw new IndeterminateError(PROVIDER, 'M24 Logistics holds several orders for the reference');
  }
  return matching[0]!;
}

/**
 * The reply of the order page's server action, as `readActionReply` reads it:
 * the orders that answer to the reference, each with its parcels and their
 * scans. M24 writes each scan's wall clock without a zone; scans are read in
 * South Africa's, ordered newest first, and a scan repeated across parcels is
 * kept once.
 */
export function parseM24(reply: unknown, number: string): CarrierResult {
  const order = orderFor(reply, number);
  const parcels = list(order, 'Parcels', MAX_PARCELS);
  const rows = parcels.flatMap(parcel => list(parcel, 'ParcelBackstamps', MAX_PARCELS))
    .flatMap(stamp => list(stamp, 'Statuses', MAX_SCANS));
  // An order whose parcels list no scans keeps its summary's.
  const source = rows.length ? rows : list(order, 'Summary', MAX_SCANS);
  if (source.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'M24 Logistics returned too many scans');

  const seen = new Set<string>();
  const events: { event: CarrierEvent; index: number; at: number }[] = [];
  source.forEach((row) => {
    const { key, event } = scan(row);
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ event, index: events.length, at: Date.parse(event.time!) });
  });
  // Newest first; scans at the same instant keep M24's order, which lists the oldest first.
  const ordered = events.sort((left, right) => right.at - left.at || right.index - left.index).map(({ event }) => event);
  const newest = ordered[0];
  if (!newest) throw new IndeterminateError(PROVIDER, 'M24 Logistics returned an order without scans');
  const current = ordered.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current : undefined;
  const signee = delivered && parcels.length === 1 ? text(parcels[0]!, 'DeliverySignee', 120) : '';
  const service = text(order, 'ServiceName', 120);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    provider_code: newest.provider_code!,
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    ...(signee ? { signed_by: signee } : {}),
    ...(service ? { service_name: service } : {}),
    events: ordered,
  };
}
