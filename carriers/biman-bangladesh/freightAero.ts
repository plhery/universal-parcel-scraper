import type { AdapterEnvironment, TrackingContext } from '../../core/adapter/index.js';
import {
  BudgetExceededError, ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError,
  SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { freightAeroStage } from './status.js';

/** CHAMP's air cargo tracker, which several airlines link as their own. */
export const FREIGHT_AERO_PAGE = 'https://www.freight.aero/tracking.asp';
/** The lookup the page posts once its reCAPTCHA calls back. */
export const FREIGHT_AERO_LOOKUP = 'https://www.freight.aero/tracking_service.asp?uuid=&is_portlet=0';
/** The address the browser service knows a lookup by: the tracker with the whole waybill after its hash. */
export const freightAeroPageUrl = (waybill: string): string => `${FREIGHT_AERO_PAGE}#${waybill}`;

const MAX_BYTES = 512 * 1024;
const MAX_EVENTS = 500;

/** An airline the tracker lists, by its catalog id, its two-letter code and its waybill prefix. */
export interface FreightAeroAirline {
  provider: string;
  name: string;
  code: string;
  prefix: string;
}

/**
 * The whole waybill, as the tracker words it: "997-67220602". The prefix may be left out, and the
 * serial ends in its check digit, the first seven digits' remainder by seven.
 */
export function freightAeroWaybill(raw: string, airline: FreightAeroAirline): string {
  const digits = raw.trim().replace(/[\s-]/g, '');
  const serial = digits.length === 11 && digits.startsWith(airline.prefix) ? digits.slice(3) : digits;
  if (!/^\d{8}$/.test(serial) || !/^[\d\s-]+$/.test(raw.trim()) || Number(serial.slice(0, 7)) % 7 !== Number(serial[7])) {
    throw new InvalidInputError(airline.provider, `Enter a ${airline.name} air waybill: ${airline.prefix}, then eight digits`);
  }
  return `${airline.prefix}-${serial}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "13-Jan-2026 03:55", the station's wall clock.
const CLOCK = /^(\d{1,2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2})$/;
// The station is named in bold with its airport code: "… at <b>Toronto (YYZ)</b>." for an arrival
// or a delivery, "… from <b>Dhaka Hazrat Shahjalal (DAC)</b> to <b>…</b>" for a booking or a departure.
const AT = /\bat <b>([^<>]{1,100}\([A-Z]{3}\))<\/b>\.?\s*$/;
const FROM = /\bfrom <b>([^<>]{1,100}\([A-Z]{3}\))<\/b> to <b>/;
const PIECES = /^(Part|Total) shipment of (\d{1,6}) pieces?\b/;

const text = (value: unknown): string => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,;:])/g, '$1').trim() : '';

function localTime(value: unknown): string {
  const match = CLOCK.exec(typeof value === 'string' ? value.trim() : '');
  const month = match ? MONTHS.indexOf(match[2]!) + 1 : 0;
  if (!match || !month) return '';
  const [day, year, hour, minute] = [Number(match[1]), Number(match[3]), Number(match[4]), Number(match[5])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2001 || year > 2100 || date.getUTCDate() !== day || hour > 23 || minute > 59) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${match[4]}:${match[5]}:00`;
}

interface Move { event: CarrierEvent & { local_time: string; description: string }; sequence: number; status: string; pieces?: { whole: boolean; count: number } }

function move(value: unknown, airline: FreightAeroAirline): Move {
  const row = isRecord(value) ? value : null;
  const status = typeof row?.status === 'string' ? row.status.trim() : '';
  const detail = typeof row?.detail === 'string' ? row.detail : '';
  const sequence = row?.eventSequenceNumber;
  const local = localTime(row?.eventTime);
  const description = text(detail) || status;
  if (!status || status.length > 100 || !local || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new SchemaError(airline.provider, `${airline.name} returned an invalid tracking event`);
  }
  const location = (AT.exec(detail) ?? FROM.exec(detail))?.[1]?.trim();
  const pieces = PIECES.exec(description);
  return {
    sequence, status,
    ...(pieces ? { pieces: { whole: pieces[1] === 'Total', count: Number(pieces[2]) } } : {}),
    event: { local_time: local, description, ...(location ? { location } : {}), provider_code: status },
  };
}

/** Reads the tracker's reply for one waybill. */
export function parseFreightAero(body: string, waybill: string, airline: FreightAeroAirline): CarrierResult {
  let reply: unknown;
  try { reply = JSON.parse(body); } catch { throw new SchemaError(airline.provider, `${airline.name} returned invalid tracking JSON`); }
  if (isRecord(reply) && reply.error === 'Too many requests') throw new RateLimitedError(airline.provider);
  if (!Array.isArray(reply) || reply.length !== 1 || !isRecord(reply[0])) throw new SchemaError(airline.provider, `${airline.name} returned an invalid tracking reply`);
  const row = reply[0];
  if (row.awbNumber !== waybill || (row.carrier !== airline.code && row.carrier != null)) {
    throw new IndeterminateError(airline.provider, `${airline.name} answered for another waybill`);
  }
  if (row.responseCode === 'NOT_FOUND') throw new NotFoundError(airline.provider, `${airline.name} does not hold this waybill`);
  if (row.responseCode === 'ERROR') throw new IndeterminateError(airline.provider, `${airline.name} could not look the waybill up`);
  if (row.responseCode !== 'OK') throw new SchemaError(airline.provider, `${airline.name} returned an unknown tracking answer`);
  if (row.events === null || (Array.isArray(row.events) && !row.events.length)) {
    throw new NoHistoryError(airline.provider, `${airline.name} lists the waybill without events`, { reason: 'listed' });
  }
  if (!Array.isArray(row.events) || row.events.length > MAX_EVENTS) throw new SchemaError(airline.provider, `${airline.name} returned an invalid history`);

  // The tracker writes events in the order its stations report them. Their clocks are each
  // station's own, so the order, not the clocks, says which came last.
  const moves = row.events.map((value) => move(value, airline)).sort((a, b) => b.sequence - a.sequence || b.event.local_time.localeCompare(a.event.local_time));
  const seen = new Set<string>();
  const kept = moves.filter((item) => {
    const key = JSON.stringify([item.event.local_time, item.event.description, item.event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  const first = (statuses: (status: string) => boolean) => Math.min(...kept.filter((item) => statuses(item.status)).map((item) => item.sequence));
  const received = first((status) => status !== 'Booked'), departed = first((status) => status === 'Departed');
  for (const item of kept) {
    let stage = freightAeroStage(item.status);
    // A booking after the shipment was received moves pieces onto a later flight.
    if (item.status === 'Booked' && item.sequence > received) stage = item.sequence > departed ? 'in_transit' : 'accepted';
    if (stage) Object.assign(item.event, { stage, stage_source: 'carrier_map' as const });
  }

  // A waybill delivered in parts is delivered once its pieces are: until then its latest other stage leads.
  const total = typeof row.totalPieces === 'number' && Number.isSafeInteger(row.totalPieces) ? row.totalPieces : 0;
  const deliveries = kept.filter((item) => item.event.stage === 'delivered');
  const whole = deliveries.some((item) => !item.pieces || item.pieces.whole)
    || (total > 0 && deliveries.reduce((sum, item) => sum + (item.pieces?.count ?? 0), 0) >= total);
  const staged = kept.filter((item) => item.event.stage);
  const current = (whole ? staged[0] : staged.find((item) => item.event.stage !== 'delivered') ?? staged[0])?.event.stage as Stage | undefined;
  const newest = kept[0]!;
  return {
    status: current ? languageStageStatus(current) : 'unknown',
    ...(current ? { current_stage: current, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.event.description,
    last_update: null,
    last_update_local: newest.event.local_time,
    expected_delivery: null,
    events: kept.map((item) => item.event),
  };
}

/** Opens the tracker in the browser service for one waybill and reads the lookup its page posts. */
export class FreightAeroTracker {
  constructor(private readonly environment: AdapterEnvironment, private readonly airline: FreightAeroAirline) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const waybill = freightAeroWaybill(raw, this.airline);
    return runSteps({ carrier: this.airline.provider, recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 80_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(waybill, signal, remainingMs) },
    ]);
  }

  // The tracker posts its lookup only from its own page, once its reCAPTCHA checkbox has passed.
  private async browser(waybill: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const { provider, name } = this.airline, trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(provider, `${name} needs the browser tracking service`);
    const url = freightAeroPageUrl(waybill);
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(75_000, remainingMs - allowance));
    if (timeoutMs < 15_000) throw new BudgetExceededError(provider, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [FREIGHT_AERO_LOOKUP], settleTimeout: timeoutMs }, { provider, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(provider, `${name}'s tracker left its page`);
      const replies = page.capturedResponses.filter(row => row.url === FREIGHT_AERO_LOOKUP);
      if (replies.length > 1) throw new SchemaError(provider, `${name}'s tracker returned too many replies`);
      // The service carries the bound waybill's digits without the hyphen.
      if (replies.some(row => row.trackingNumberSubmitted !== waybill.replace('-', ''))) throw new SchemaError(provider, `${name}'s tracker did not bind the whole waybill`);
      const row = replies[0];
      if (row) {
        if (row.error === 'challenge-html') throw new ChallengeError(provider, `${name}'s tracker refused browser verification`, { status: row.status });
        if (row.error === 'invalid-json') throw new SchemaError(provider, `${name} returned invalid tracking JSON`);
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) throw new TransportError(provider, `${name} returned incomplete tracking data`);
        if ([401, 403, 428].includes(row.status)) throw new ChallengeError(provider, `${name}'s tracker refused browser verification`, { status: row.status });
        const retryAfter = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        if (row.status === 429) throw new RateLimitedError(provider, retryAfter);
        // A refused reCAPTCHA token gets the same server error page as an outage.
        if (row.status !== 200) throw new UpstreamHttpError(provider, row.status, retryAfter);
        return parseFreightAero(row.body, waybill, this.airline);
      }
      if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(provider, `${name}'s tracker refused its page`, { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(provider);
      if (page.statusCode >= 400) throw new UpstreamHttpError(provider, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (reason === 'freight-aero-airline_missing') throw new SchemaError(provider, `The tracker no longer lists ${name}`);
      if (reason === 'freight-aero-runtime') throw new TransportError(provider, `${name}'s tracker could not be opened`);
      // The page posts nothing until its reCAPTCHA passes.
      throw new ChallengeError(provider, `${name}'s tracker kept its reCAPTCHA`);
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}
