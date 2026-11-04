import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { isSpxHiddenMilestone } from '../spx-id/codes.js';
import { spxBrStage } from './status.js';

export const PROVIDER = 'SPX Express Brazil';
// A long cross-border history in Portuguese is under fifty kilobytes.
export const SPX_BR_MAX_BYTES = 1_000_000;
// BR, twelve digits and a final digit or letter: the numbers the tracker's links carry.
const NUMBER = /^BR\d{12}[0-9A-Z]$/;
// The order index's own count of parcels under the number: none.
const UNKNOWN = /GetLogisticOrderIndexMap[\s\S]*\bfind \[0\]/;
const CODE = /^[A-Z0-9_]{1,16}$/;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;
// Scans at SPX's warehouses, forwarders, ports, hubs and sorting centres, on
// the way out and back. Pickups, deliveries and the return to the seller
// name the seller's or the recipient's town, which is not kept.
const FACILITY = /^F(?:[2-5]\d\d|67\d|680)$/;
// Wordings that name the centre, origin or port of their scan after a colon:
// "Seu pedido saiu do centro logístico: Cidade Exemplo - SP", and the arrival
// "O pedido chegou ao centro de : Cidade Exemplo - SP e segue para a próxima etapa.".
const PLACED = [
  /^(.*\b(?:centro log[ií]stico|origem|porto de tr[âa]nsito))\s*:\s*([^:]*\S)$/i,
  /^(O pedido chegou ao centro) de\s*:\s*(\S.*?)( e segue para a próxima etapa\.?)$/i,
];

// A posting names the town of the point where the seller dropped the parcel off after its
// wording ("Pedido postado Cidade Exemplo - SP"): the seller's town, which a pickup keeps none of.
const POSTED = /^(Pedido postado)\s+\S.*\s-\s[A-Z]{2}$/i;

/** A posting's wording without the town of its drop-off point. */
export function spxBrPostedText(wording: string): string {
  return wording.replace(POSTED, '$1');
}

/** A number for SPX Brazil's tracker; anything else is not one it issues. */
export function normalizeSpxBrNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SPX Express Brazil numbers are BR, twelve digits and a final digit or letter');
  return number;
}

// Who took the parcel: "Recebido por: …" after a delivery, or the bracketed
// name the tracker's pt-BR wording puts after "entregue a", which a partner
// carrier's delivery leaves empty.
const RECEIVER = /\s*[.,;]?\s*\b(?:recebid[oa]|retirad[oa]|assinad[oa]) por\s*:[\s\S]*$/i;
const NAMED = /\b(entregue)\s+(?:a|ao|à|para)(?:\s+\[[^\]]*\][\s\S]*|\s*)$/i;

/** A scan's wording without the name of whoever took the parcel. */
export function spxBrWording(text: string): string {
  // A line whose template left its place empty ("está a caminho .") ends on a spaced stop.
  return clean(clean(text, 1000).replace(RECEIVER, '').replace(NAMED, '$1'), 500).replace(/[\s,;:]+$/, '').replace(/\s+\.$/, '.');
}

/**
 * A facility scan's wording without the centre, origin or port it names, and
 * that place, so the wording reads the same from town to town.
 */
export function spxBrPlacedText(wording: string): { description: string; location: string } {
  for (const pattern of PLACED) {
    const match = pattern.exec(wording);
    if (match) return { description: match[1]!.trim() + (match[3] ?? ''), location: match[2]!.trim() };
  }
  return { description: wording, location: '' };
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `SPX Express Brazil returned an invalid ${key}`);
  return value;
}

function projectRow(row: Record<string, unknown>): CarrierEvent | null {
  // The page leaves out the rows SPX flags hidden; its milestones among them stay.
  if (row.display_flag === 0 && !isSpxHiddenMilestone(row)) return null;
  const code = text(row, 'tracking_code').trim().toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid tracking code');
  // A few scans have no line of their own; their English tracking name stands in.
  const description = spxBrWording(text(row, 'description')) || clean(text(row, 'tracking_name'), 200);
  if (!description) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a scan without wording');
  const clock = row.actual_time;
  const time = typeof clock === 'number' && Number.isSafeInteger(clock) && clock >= 1_000_000_000 && clock < 10_000_000_000
    ? epochSecondsTime(clock)?.iso : undefined;
  if (!time) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid scan time');
  const facility = FACILITY.test(code);
  // The reply's place stands; a place named only in the wording stands in for it.
  const named = facility ? spxBrPlacedText(description) : { description: spxBrPostedText(description), location: '' };
  const place = facility && isRecord(row.current_location) ? row.current_location : null;
  const location = (place ? clean(text(place, 'location_name'), 120) : '') || clean(named.location, 120);
  const point = place && location ? eventPoint(place.lat, place.lng) : null;
  const staged = spxBrStage(code, named.description);
  return {
    time, ...(location ? { location } : {}), ...(point ? { point } : {}), description: named.description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The refusal's codes, failing step and count, for the logs; none of the reply's own text. */
function refusal(retcode: number, message: unknown): string {
  const text = typeof message === 'string' ? message.slice(0, 2000) : '';
  const inner = /\bretcode:(-?\d{1,12})/.exec(text)?.[1];
  const step = /\bFuncName\[([A-Za-z]{1,80})\]/.exec(text)?.[1];
  const found = /\bfind \[(\d{1,6})\]/.exec(text)?.[1];
  return [`retcode ${retcode}${inner ? ` ${inner}` : ''}`, ...(step ? [`in ${step}`] : []), ...(found ? [`${found} found`] : [])].join(', ');
}

/**
 * The reply of the tracker's `get_order_info` for one number. A number SPX
 * does not know fails with the order index's count of none, which the page
 * reports as no result; any other failure is inconclusive. The tracking
 * object must name the number asked.
 */
export function parseSpxBr(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSpxBrNumber(raw);
  if (!isRecord(payload) || typeof payload.retcode !== 'number') throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid envelope');
  if (payload.retcode !== 0) {
    if (typeof payload.message === 'string' && UNKNOWN.test(payload.message)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, `SPX Express Brazil did not complete the lookup (${refusal(payload.retcode, payload.message)})`);
  }
  if (!isRecord(payload.data)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned no tracking data');
  const tracking = payload.data.sls_tracking_info;
  if (tracking === undefined || tracking === null) throw new NoHistoryError(PROVIDER);
  if (!isRecord(tracking) || typeof tracking.sls_tn !== 'string') throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a shipment without its number');
  if (normalizeTrackingNumber(clean(tracking.sls_tn, 64)) !== number) throw new IndeterminateError(PROVIDER, 'SPX Express Brazil answered for another shipment');
  const rows = tracking.records ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an oversized history');

  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid scan');
    const event = projectRow(row);
    if (event) events.push(event);
  }
  return summarize(events);
}

/** The result for a history's scans, each once and newest first. */
function summarize(scans: readonly CarrierEvent[]): CarrierResult {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const event of scans) {
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Every scan is an instant. The reply lists a customs check filed late
  // among later scans; newest first by the clock, the order stays stable.
  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

// The fleet feed's answer for a number it holds no scans for.
const FLEET_NO_HISTORY = -1217;
const FLEET_STATUS = /^[A-Za-z0-9_]{1,64}$/;
// The hub a fleet line opens with: "[LM Hub_RJ_Exemplo] Seu pacote foi recebido pelo centro de distribuição".
const HUB = /^\[((?:FM|LM) ?Hub_[^\]]{1,100}|SoC_[^\]]{1,100})\]\s*/i;
// The bracketed name the feed's English line puts after a delivery.
const LAST_NAMED = /\s*\[[^\]]*\]\s*$/;
// A drop-off point's line opens with the point's name, often its keeper's: "[Nome] Seu pacote foi recebido pelo ponto de coleta".
// A partner carrier's delivery opens with the partner's code: "[00000] Pacote foi entregue a".
const OPENING_NAME = /^\[[^\]]{1,200}\]\s*/;
// A line haul's transfer and trip, in English in every language: "[TO…] unloading at [SoC_SP_Exemplo] via Linehaul Trip [LT…]".
const LINE_HAUL = /^\[[^\]]{1,64}\]\s*(unload(?:ing|ed)) at \[([^\]]{1,100})\]\s*via linehaul trip\s*\[[^\]]{1,64}\]$/i;
// A line haul leaving for a hub: "Pacote [TO…] está sendo transportado para [SoC_SP_Exemplo]".
const TRANSFER_ID = /^(pacote) \[[^\]]{1,64}\]\s*/i;
const NEXT_HUB = /\[((?:FM|LM) ?Hub_[^\]]{1,100}|SoC_[^\]]{1,100})\]$/i;
// The longest a hub's unloading runs before the hub's own scan takes the parcel in.
const UNLOADING_MS = 24 * 60 * 60 * 1000;

function projectFleetRow(row: Record<string, unknown>): CarrierEvent {
  if (typeof row.status !== 'string' || !FLEET_STATUS.test(row.status.trim())) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid fleet status');
  const code = row.status.trim();
  if (typeof row.message !== 'string') throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a scan without wording');
  const worded = spxBrWording(row.message);
  const line = code === 'Delivered' ? clean(worded.replace(LAST_NAMED, ''), 500) : worded;
  // The hub leaves the wording, so it reads the same from hub to hub, and is the place of
  // the hub taking the parcel in. A pickup or a delivery names the hub that made it, not
  // where it happened.
  const hub = HUB.exec(line);
  // A line haul's unloading keeps its verb, at the hub it names; the transfer and trip ids
  // leave, as does the transfer id of a line haul leaving for a hub.
  const haul = LINE_HAUL.exec(line);
  const description = haul ? haul[1]!.charAt(0).toUpperCase() + haul[1]!.slice(1).toLowerCase()
    : hub ? line.slice(hub[0].length)
      : /^(?:DOP|3PL)_/i.test(code) ? line.replace(OPENING_NAME, '')
        : /_LHTransporting$/i.test(code) ? line.replace(TRANSFER_ID, '$1 ').replace(NEXT_HUB, '$1') : line;
  if (!description) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a scan without wording');
  const location = haul ? clean(haul[2], 120) : hub && /_Received$/i.test(code) ? clean(hub[1], 120) : '';
  const clock = row.timestamp;
  const time = typeof clock === 'number' && Number.isSafeInteger(clock) && clock >= 1_000_000_000 && clock < 10_000_000_000
    ? epochSecondsTime(clock)?.iso : undefined;
  if (!time) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid scan time');
  const staged = spxBrStage(code, description);
  return {
    time, ...(location ? { location } : {}), description, provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of the tracker's fleet feed for one number, which it reads when the order
 * lookup does not hold the number. The feed names no missing parcel: an unknown number
 * fails like any other lookup, so only a reply naming the number asked counts. Shopee's
 * gateway answers a refused request with an action instead of a reply, and a checksum it
 * rejects with empty data. The recipient and phone fields are not read.
 */
export function parseSpxBrFleet(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSpxBrNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid fleet envelope');
  if (payload.retcode === undefined && (payload.action_type !== undefined || payload.redirect_to_error_page !== undefined)) {
    throw new ChallengeError(PROVIDER, "SPX Express Brazil's gateway refused the fleet lookup");
  }
  if (typeof payload.retcode !== 'number') throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid fleet envelope');
  if (payload.retcode === FLEET_NO_HISTORY) throw new NoHistoryError(PROVIDER);
  if (payload.retcode !== 0) throw new IndeterminateError(PROVIDER, `SPX Express Brazil's fleet feed did not complete the lookup (retcode ${payload.retcode})`);
  if (!isRecord(payload.data)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned no fleet data');
  const data = payload.data;
  if (!Object.keys(data).length) throw new IndeterminateError(PROVIDER, "SPX Express Brazil's fleet feed returned an empty reply");
  if (typeof data.sls_tracking_number !== 'string') throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a shipment without its number');
  if (normalizeTrackingNumber(clean(data.sls_tracking_number, 64)) !== number) throw new IndeterminateError(PROVIDER, 'SPX Express Brazil answered for another shipment');
  const rows = data.tracking_list ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an oversized history');
  return summarize(withoutUnloading(rows.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid scan');
    return projectFleetRow(row);
  })));
}

/**
 * A line haul's unloading at a hub, where the hub's own scan takes the parcel in at or after
 * it, within a day: that scan stands for the arrival. An unloading the hub has not yet
 * followed with its scan stays.
 */
function withoutUnloading(events: readonly CarrierEvent[]): CarrierEvent[] {
  return events.filter((event) => !/_LHUnload(?:ing|ed)$/i.test(event.provider_code ?? '') || !event.location
    || !events.some((taken) => /_Received$/i.test(taken.provider_code ?? '') && taken.location === event.location
      && Date.parse(taken.time!) >= Date.parse(event.time!) && Date.parse(taken.time!) - Date.parse(event.time!) <= UNLOADING_MS));
}
