/**
 * The public tracker of AU-OPS (乐代, Shenzhen Ledai), a forwarder platform whose service picks the
 * tenant by the host it is asked for. `/#/public-tracking?orderNum=<number>` on a tenant's site
 * asks `GET /edi/pubTracking` with the number and that host, and shows one order per number: its
 * state, its tracking rows and the numbers it was handed over under. The reply model, nodes and
 * states come from the platform's script and translations, which every tenant shares.
 */
import { readerLanguage, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { PlannedEvent } from '../../core/result/planned.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { furtherAlong } from '../../core/status/progress.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { countryCode, epochMillisTime, explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { clean, cleanScalar, textFromHtml } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { withoutContacts } from '../tmw-express/parser.js';
import { auOpsEstimate, auOpsNode, auOpsState, auOpsStatusMap, type AuOpsLanguage } from './auOpsStatus.js';

/** One tenant of the platform. */
export interface AuOpsTenant {
  /** The carrier's catalog id, which names it in errors and steps. */
  readonly id: string;
  /** The host of the tenant's site, which the service picks the tenant by. */
  readonly host: string;
}

export const AU_OPS_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_BUDGET_MS = 15_000;
const MAX_ROWS = 500;
// The tracker takes any token, several to a request split by spaces; a number is letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,40}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const REDIRECTS = [301, 302, 303, 307, 308];
// The service's states that leave the order on its way, which a newer delivered row outranks.
const ON_THE_WAY = new Set<string>(['registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery']);
// No clock before 2000: a moment in seconds read as milliseconds lands in 1970.
const EARLIEST = Date.UTC(2000, 0, 1);

/** A number the tracker takes: letters and digits, with a digit. */
export function normalizeAuOpsNumber(id: string, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(id, 'AU-OPS order numbers are 5 to 40 letters and digits');
  return number;
}

/** The address the public tracker reads one number from, for the tenant at `host`. */
export function auOpsUrl(host: string, number: string): string {
  const query = new URLSearchParams({ soNum: number, url: '/public-tracking', host, noSubTracking: 'true' });
  return `https://${host}/edi/pubTracking?${query.toString()}`;
}

export class AuOpsTracker {
  constructor(private readonly tenant: AuOpsTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, language: AuOpsLanguage, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(auOpsUrl(this.tenant.host, number), { signal,
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
      provider: this.tenant.id, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AU_OPS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] })
      // A request the caller cancelled ends with the caller's reason.
      .catch((error: unknown) => { signal.throwIfAborted(); throw error; });
    signal.throwIfAborted();
    return parseAuOpsReply(this.tenant, response.status, decodeText(bytes), number, language);
  }

  async fetch(raw: string, context: TrackingContext = {}, language: AuOpsLanguage = 'en'): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeAuOpsNumber(this.tenant.id, raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: this.tenant.id, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, language, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, language, signal, remainingMs)),
    ]);
  }
}

/** The adapter of one tenant: its rows worded in Chinese for a Chinese reader, in English for everyone else. */
export function auOps(tenant: AuOpsTenant): AdapterFactory {
  return (environment) => {
    const tracker = new AuOpsTracker(tenant, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return { id: tenant.id, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context, readerLanguage(input, ['zh']) ?? 'en') };
  };
}

/** One reply of the service: its JSON, a verification page, or a moved or changed service. */
export function parseAuOpsReply(tenant: AuOpsTenant, status: number, body: string, raw: string, language: AuOpsLanguage = 'en'): CarrierResult {
  // The service answers a number it does not have with HTTP 200 too, so any other status says nothing about the number.
  if (status !== 200) throw new TransportError(tenant.id, 'The AU-OPS tracking service moved', { status });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(tenant.id, 'AU-OPS answered with a verification page', { cause });
    throw new SchemaError(tenant.id, 'AU-OPS answered with a page instead of its tracking JSON', { cause });
  }
  return parseAuOps(tenant, payload, raw, language);
}

/**
 * The reply for one number: a list with one order. A number the service does not have is an
 * order marked `notFound` that repeats the number and holds nothing else. A found order repeats
 * the number too, or carries it as its job number.
 */
export function parseAuOps(tenant: AuOpsTenant, payload: unknown, raw: string, language: AuOpsLanguage = 'en'): CarrierResult {
  const { id } = tenant;
  const number = normalizeAuOpsNumber(id, raw);
  const invalid = (message: string): never => { throw new SchemaError(id, message); };
  if (!Array.isArray(payload)) return invalid('AU-OPS returned no list of orders');
  if (!payload.length) return invalid('AU-OPS returned no order for the number');
  if (payload.length > 1) throw new IndeterminateError(id, 'AU-OPS returned several orders for one number');
  const order: unknown = payload[0];
  if (!isRecord(order)) return invalid('AU-OPS returned an invalid order');

  const named = [order.trackingNum, order.jobNum].map(folded).filter(Boolean);
  if (!named.length) return invalid('AU-OPS did not identify the requested number');
  if (!named.includes(number)) throw new IndeterminateError(id, 'AU-OPS answered for another number');
  const rows = rowsOf(order, 'trackings', invalid);
  const handovers = rowsOf(order, 'subTrackings', invalid);
  rowsOf(order, 'headNodes', invalid);
  if (order.notFound === true) {
    if (rows.length || handovers.length || order.jobNum != null || order.guideId != null) return invalid('AU-OPS marked an order it lists as not found');
    throw new NotFoundError(id, 'AU-OPS does not have this number');
  }
  if (order.notFound != null && order.notFound !== false) return invalid('AU-OPS returned an unexpected not-found mark');

  const { scans, planned } = readRows(rows, language, invalid);
  const handoff = handoffOf(order, handovers, number, id);
  const destination = destinationOf(order.destCountry);
  const code = cleanScalar(order.state, 8);
  // `0`, on the way, is also the state of a number the service does not have, so it says the least.
  const state = code && code !== '0' ? auOpsState(code) : undefined;
  if (!scans.length) {
    if (!state?.stage) {
      throw new NoHistoryError(id, 'AU-OPS lists the order without a tracking row', { reason: 'listed', ...(planned.length ? { plannedEvents: planned } : {}),
        ...(handoff.delivery_carrier ? { deliveryCarrier: handoff.delivery_carrier } : {}),
        ...(handoff.delivery_tracking_number ? { deliveryTrackingNumber: handoff.delivery_tracking_number } : {}) });
    }
    return { status: languageStageStatus(state.stage), current_stage: state.stage, current_stage_source: 'carrier_map', last_status_text: state[language],
      provider_code: code, last_update: null, expected_delivery: null, summary_only: true, ...handoff, ...destination,
      ...(planned.length ? { planned_events: planned } : {}), events: [] };
  }

  const events = scans;
  const lead = leadingScan(events, auOpsStatusMap);
  const scanned = lead?.stage as Stage | undefined;
  // The state decides, as the label beside the order; a row further along the way, or a delivery after a state
  // still on the way, is newer than it.
  const byState = state?.stage !== undefined && !(scanned && (furtherAlong(state.stage, scanned) || (scanned === 'delivered' && ON_THE_WAY.has(state.stage))));
  const stage = byState ? state.stage : scanned ?? (code === '0' ? auOpsState('0')!.stage! : undefined);
  const source = byState || !scanned ? 'carrier_map' : lead!.stage_source ?? 'carrier_map';
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: byState ? state[language] : events[0]!.description!,
    ...(byState ? { provider_code: code } : {}),
    last_update: events[0]!.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...handoff,
    ...destination,
    ...(planned.length ? { planned_events: planned } : {}),
    events,
  };
}

// A number reaches the reader in capitals and without separators, so the reply's own is compared the same way.
function folded(value: unknown): string {
  return typeof value === 'string' && value.length <= 80 ? normalizeTrackingNumber(value.trim()) : '';
}

/** A list of the order: absent is empty; anything but a list of objects is a changed reply. */
function rowsOf(order: Record<string, unknown>, key: string, invalid: (message: string) => never): Record<string, unknown>[] {
  const rows = order[key];
  if (rows == null) return [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS || !rows.every(isRecord)) return invalid(`AU-OPS returned an invalid ${key} list`);
  return rows;
}

/** A row's event time, which the platform orders rows by: an instant with its offset, or milliseconds since 1970. */
function clockOf(value: unknown, invalid: (message: string) => never): ParsedTime {
  const at = typeof value === 'number' ? epochMillisTime(value) : explicitOffsetTime(value);
  if (!at || at.timestamp < EARLIEST) return invalid('AU-OPS returned a tracking row without an instant');
  return at;
}

interface Scan { event: CarrierEvent; at: number; index: number }

/**
 * The tracking rows: each is a node, a context and the event time the page dates it by. A row
 * for an estimated date is a planned step. The page shows a node's own wording when the row has
 * no context, and a node it does not translate as it is.
 */
function readRows(rows: readonly Record<string, unknown>[], language: AuOpsLanguage, invalid: (message: string) => never) {
  const scans: Scan[] = [];
  const planned: { step: PlannedEvent; at: number }[] = [];
  rows.forEach((row, index) => {
    const node = clean(row.node, 80);
    const context = withoutContacts(textFromHtml(row.context, 1000));
    const at = clockOf(row.eventTime, invalid);
    const estimate = auOpsEstimate(node);
    if (estimate) {
      planned.push({ at: at.timestamp, step: { time: at.iso, description: context || estimate[language] } });
      return;
    }
    const known = auOpsNode(node);
    const description = context || known?.[language] || node;
    if (!description) invalid('AU-OPS returned a tracking row without a node or a context');
    // A node of the tenant's own is kept as its code, and its wording read by the shared rules.
    const worded = known ? null : classifyWording(description, 'in_transit');
    const stage = known ? (known.stage ? { stage: known.stage, stage_source: 'carrier_map' } : {})
      : worded && worded.source !== 'none' ? { stage: worded.stage, stage_source: worded.source } : {};
    scans.push({ at: at.timestamp, index, event: { time: at.iso, description, ...(node ? { provider_code: node } : {}), ...stage } });
  });
  // Newest first. The page lists rows in either order; rows on one clock keep the order of the steps.
  const oldestFirst = scans.length > 1 && scans[0]!.at < scans[scans.length - 1]!.at;
  scans.sort((left, right) => right.at - left.at || (oldestFirst ? right.index - left.index : left.index - right.index));
  planned.sort((left, right) => left.at - right.at);
  return { scans: scans.map(({ event }) => event), planned: planned.map(({ step }) => step) };
}

/**
 * The number the order was handed over under, when it names exactly one: in a parcel of several
 * cartons each has its own, and none of them is the parcel's. Its carrier is named when the
 * catalog knows the name the reply gives, the handover's or the order's, and its rules fit the number.
 */
function handoffOf(order: Record<string, unknown>, handovers: readonly Record<string, unknown>[], number: string, id: string):
  Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const references = [...new Set(handovers.map((handover) => folded(handover.trackingNum)).filter((reference) => /^[A-Z0-9]{4,40}$/.test(reference) && reference !== number))];
  if (references.length !== 1) return {};
  const reference = references[0]!;
  const handover = handovers.find((candidate) => folded(candidate.trackingNum) === reference)!;
  const names = [handover.carrier, handover.carrierCode, order.carrier, order.carrierCode].map((name) => clean(name, 80)).filter(Boolean);
  const partner = names.map((name) => carrierIdFromPartner(name)).find(Boolean);
  const named = partner && partner !== id && (detectCarrierMatch(reference).candidates as string[]).includes(partner);
  return { ...(named ? { delivery_carrier: partner } : {}), delivery_tracking_number: reference };
}

/** The destination as the page shows it: a country code or name the library reads, else the label as given. */
function destinationOf(value: unknown): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const label = clean(value, 60);
  if (!label) return {};
  const code = countryCode(label);
  return code ? { destination_country: code } : { destination_country_name: label };
}
