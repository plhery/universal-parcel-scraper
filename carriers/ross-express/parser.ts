import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { DELIVERED_LIFECYCLE, QUOTE_LIFECYCLE, rossStage, statusMap } from './status.js';

export const PROVIDER = 'ross-express';
// A long history is a few kilobytes.
export const ROSS_MAX_BYTES = 256 * 1024;

// The trace form takes up to seven digits. Numbers of six and seven digits hold shipments and quotes.
const NUMBER = /^\d{6,7}$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;
// The trace's answer for a PRO it does not hold: "Invalid pronumber 0000001".
const NOT_FOUND = /^Invalid pronumber(?: (\S+))?$/;
// The error page of Carrier Logistics' WebSpeed broker, for a lookup the tracker could not run.
const WEBSPEED = /WebSpeed error|WebSpeed Agent/i;
// Firewall and bot check pages, which could stand in for the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|requested URL was rejected|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
// A town and its state, as delivery rows give it: "Willimantic, CT". A Ross terminal is
// written "Ross Auburn, MA"; its town is kept.
const PLACE = /^\p{L}[\p{L} .'-]{0,59}, [A-Z]{2}$/u;
const TERMINAL = /^Ross\s+/i;
const POUNDS = /^\d{1,6}(?:\.\d+)?$/;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_ROWS = 300;

/** A Ross Express PRO: six or seven digits, as typed. */
export function normalizeRossNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || /^0+$/.test(number)) throw new InvalidInputError(PROVIDER, 'Ross Express PROs are six or seven digits');
  return number;
}

function elements(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name && child.uri === '');
}

/** One text field; a repeated field or one that nests elements is a changed reply. */
function text(node: XmlNode, name: string, maxLength = 200): string {
  const found = elements(node, name);
  if (found.length > 1 || found[0]?.children.length) throw new SchemaError(PROVIDER, `Ross Express returned an invalid ${name}`);
  return clean(found[0]?.text ?? '', maxLength);
}

/** A row's date and 24-hour time as a wall clock. The trace gives no zone; a time without digits leaves the day. */
function wallClock(date: string, time: string): string {
  const parts = ISO_DAY.exec(date);
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!day) throw new SchemaError(PROVIDER, 'Ross Express returned an invalid history date');
  if (!/\d/.test(time)) return day;
  const match = TIME.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new SchemaError(PROVIDER, 'Ross Express returned an invalid history time');
  return `${day}T${match[1]}:${match[2]}:00`;
}

/** One history row: its clock, the wording and its town when the remark names one. */
function rowOf(row: XmlNode): CarrierEvent {
  const description = text(row, 'histcode', 300);
  if (!description) throw new SchemaError(PROVIDER, 'Ross Express returned a history row without its wording');
  const local_time = wallClock(text(row, 'histdate', 16), text(row, 'histtime', 16));
  const remark = text(row, 'histremarks', 120).replace(TERMINAL, '');
  const staged = rossStage(description);
  return {
    local_time,
    ...(PLACE.test(remark) ? { location: remark } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The history rows, newest first and once each. */
function history(shipment: XmlNode): CarrierEvent[] {
  const lists = elements(shipment, 'shiphists');
  if (lists.length > 1) throw new SchemaError(PROVIDER, 'Ross Express returned two histories');
  const list = lists[0];
  const rows = list ? elements(list, 'shiphist') : [];
  if (list && rows.length !== list.children.length) throw new SchemaError(PROVIDER, 'Ross Express returned an unexpected history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Ross Express returned an oversized history');
  const seen = new Set<string>();
  const events = rows.map(rowOf).filter((event) => {
    const key = JSON.stringify([event.local_time, event.description, event.location]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The trace lists the newest first; a list the other way round is turned round.
  return events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time! ? events.reverse() : events;
}

/** The shipment's weight in pounds, as kilograms. */
function weightKg(value: string): number | null {
  const pounds = POUNDS.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(pounds) && pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/** The trace's error document: "Invalid pronumber" naming the number asked is the only missing shipment. */
function failure(root: XmlNode, pro: string): never {
  const messages = elements(root, 'errormessage');
  if (messages.length !== 1 || root.children.length !== 1 || messages[0]!.children.length) {
    throw new SchemaError(PROVIDER, 'Ross Express returned an unexpected error document');
  }
  const match = NOT_FOUND.exec(clean(messages[0]!.text, 200));
  if (!match) throw new SchemaError(PROVIDER, 'Ross Express answered with an error it does not usually give');
  if (match[1] === pro) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'Ross Express answered for another PRO');
}

/**
 * The reply of Ross Express's XML trace on Carrier Logistics (`rxic.pol/protracexml.htm`) for one
 * PRO, without a login: the shipment with its lifecycle, weight and history, newest first, or an
 * error naming the number. The references, the towns and ZIP codes of the shipper and consignee,
 * the terminals, the pieces, the delivery's clock and status line and the signer are not read.
 */
export function parseRossTrace(xml: string, raw: string): CarrierResult {
  const pro = normalizeRossNumber(raw);
  const root = xmlDocument(xml, ROSS_MAX_BYTES);
  if (!root || root.uri !== '' || !['protrace', 'error'].includes(root.name)) {
    const head = xml.slice(0, 64_000);
    if (CHALLENGE.test(head)) throw new ChallengeError(PROVIDER, 'Ross Express answered with a block page');
    if (WEBSPEED.test(head)) throw new IndeterminateError(PROVIDER, 'The Ross Express tracker could not run the lookup');
    throw new SchemaError(PROVIDER, 'Ross Express returned a reply that is not its trace document');
  }
  if (root.name === 'error') failure(root, pro);

  const number = text(root, 'pronumb', 32);
  if (!number) throw new SchemaError(PROVIDER, 'Ross Express returned a shipment without its PRO');
  // A number the trace does not hold as a PRO can match another shipment's reference.
  if (number !== pro) throw new IndeterminateError(PROVIDER, 'Ross Express answered for another shipment');

  const code = text(root, 'lifecyclestatuscode', 8);
  const lifecycle = text(root, 'lifecycle', 80);
  // A rate quote shares the numbers with shipments and has no freight behind it.
  if (code === QUOTE_LIFECYCLE || /^quote$/i.test(lifecycle)) throw new IndeterminateError(PROVIDER, 'Ross Express answered with a rate quote, not a shipment');
  const delivered = code === DELIVERED_LIFECYCLE || text(root, 'prodelivered', 8).toLowerCase() === 'yes';
  const headline: ClassifiedWording | null = delivered ? { stage: 'delivered', source: 'carrier_map' } : null;
  const events = history(root);
  if (!events.length && !headline) throw new NoHistoryError(PROVIDER, 'Ross Express lists the shipment without a history', { reason: 'listed' });

  // A delivery settles the stage; otherwise the newest staged row leads.
  const lead = leadingScan(events, statusMap);
  const decided: ClassifiedWording | null = headline
    ?? (lead?.stage ? { stage: lead.stage as Stage, source: lead.stage_source ?? 'carrier_map' } : null);
  const newest = events[0];
  const weight = weightKg(text(root, 'weight', 16));
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: newest?.description ?? (lifecycle || null),
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time! } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
