/**
 * Delyva, a Malaysian delivery platform whose couriers each run a tenant at `<code>.delyva.app`.
 * Every tenant's customer tracker asks the platform's one tracking service with the tenant's
 * company id, so a courier on Delyva needs only that id and its own provider name.
 */
import { DateTime } from 'luxon';
import type { TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { delyvaStage, delyvaWording } from './delyvaStatus.js';

/** The tracking service every tenant's customer tracker posts to. */
export const DELYVA_TRACK = 'https://api.delyva.app/v1.0/order/track';
// An order with ten scans is about 5 kB.
export const DELYVA_MAX_BYTES = 512 * 1024;
const DEFAULT_BUDGET_MS = 15_000;
const MAX_SCANS = 300;

export interface DelyvaTenant {
  /** The courier's catalog id, which names it in errors. */
  provider: string;
  /** The courier's name, for messages. */
  name: string;
  /** The tenant's company id: `companyInfo.id` in its customer tracker page's payload. */
  companyId: string;
  /** The numbers the courier issues, once normalized; letters and digits with at least one digit by default. */
  number?: RegExp;
}

// The customer tracker sends anything longer than three characters.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,40}$/;
// "2023-01-04T03:54:47.625Z": the instant the platform wrote the scan, in UTC.
const INSTANT = /^(\d{4})-\d{2}-\d{2}T(\d{2}):\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
// A firewall's, CDN's or bot check's page in place of the service's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// A scan's description is the platform's wording, " - ", then the branch or the courier's staff it names.
const SEPARATOR = ' - ';
const BRANCH_SCANS = new Set(['Arrived at branch', 'Departed from branch']);
const STAFF_SCANS = new Set(['Delivery success']);

/** A number for a Delyva tenant's tracker, in capitals without spaces. */
export function normalizeDelyvaNumber(raw: string, tenant: DelyvaTenant): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!(tenant.number ?? NUMBER).test(number)) throw new InvalidInputError(tenant.provider, `Enter the ${tenant.name} consignment number`);
  return number;
}

/** The request body the customer tracker posts for a number. */
export const delyvaRequest = (number: string, tenant: DelyvaTenant) =>
  ({ companyId: tenant.companyId, consignmentNo: number, resultType: 'latestFirst' });

/** The order in one reply; null for `{"data": false}`, the service's answer for a number it has no order under. */
export function delyvaOrder(payload: unknown, tenant: DelyvaTenant): Record<string, unknown> | null {
  if (!isRecord(payload) || !('data' in payload)) throw new SchemaError(tenant.provider, `${tenant.name} returned an unreadable reply`);
  if (payload.data === false) return null;
  if (!isRecord(payload.data)) throw new SchemaError(tenant.provider, `${tenant.name} returned an invalid order`);
  return payload.data;
}

function instant(value: unknown): string | null {
  const parts = typeof value === 'string' ? INSTANT.exec(value) : null;
  if (!parts || Number(parts[1]) < 2000 || Number(parts[2]) > 23) return null;
  const parsed = DateTime.fromISO(value as string, { setZone: true });
  return parsed.isValid ? parsed.startOf('second').toISO({ suppressMilliseconds: true }) : null;
}

function code(value: unknown, tenant: DelyvaTenant): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9999) {
    throw new SchemaError(tenant.provider, `${tenant.name} returned an invalid status code`);
  }
  return value;
}

function text(value: unknown, max: number, tenant: DelyvaTenant): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(tenant.provider, `${tenant.name} returned an invalid field`);
  return clean(value, max);
}

/**
 * A scan's wording and place. The platform's own wording names the branch that scanned the parcel,
 * which becomes the place, or the staff who delivered it, who stays behind. A description in any
 * other shape is the courier's own note, which can name people, so the scan keeps its status text.
 */
function wordingOf(description: string, statusText: string, status: number): Pick<CarrierEvent, 'description' | 'location' | 'original_description'> {
  const at = description.indexOf(SEPARATOR);
  const head = at < 0 ? description : description.slice(0, at);
  const tail = at < 0 ? '' : description.slice(at + SEPARATOR.length).trim();
  if (BRANCH_SCANS.has(head)) return { description: head, ...(tail ? { location: tail, original_description: description } : {}) };
  if (STAFF_SCANS.has(head)) return { description: head };
  return { description: statusText || delyvaWording(status) || String(status) };
}

const same = (value: unknown, number: string) => typeof value === 'string' && normalizeTrackingNumber(value) === number;

/**
 * Reads one order of a Delyva tenant. Scans keep the instant the platform wrote them, newest first.
 * The staff's names and phones, the map's coordinates, the addresses' towns and the service's codes
 * stay behind; the destination gives its country.
 */
export function parseDelyva(payload: unknown, number: string, tenant: DelyvaTenant): CarrierResult {
  const invalid = (message: string): never => { throw new SchemaError(tenant.provider, `${tenant.name} ${message}`); };
  const order = delyvaOrder(payload, tenant);
  if (!order) throw new NotFoundError(tenant.provider, `${tenant.name} has no consignment under this number`);
  if (!same(order.consignmentNo, number) || (order.companyId !== undefined && order.companyId !== tenant.companyId)) {
    throw new IndeterminateError(tenant.provider, `${tenant.name} answered for another consignment`);
  }
  const histories = order.histories ?? [];
  if (!Array.isArray(histories) || histories.length > MAX_SCANS) return invalid('returned an invalid history');
  const events = histories.map((row, index) => {
    if (!isRecord(row)) return invalid('returned an invalid scan');
    if (row.consignmentNo !== undefined && !same(row.consignmentNo, number)) {
      throw new IndeterminateError(tenant.provider, `${tenant.name} answered with another consignment's scans`);
    }
    const status = code(row.statusCode, tenant);
    const time = instant(row.createdAt) ?? invalid('returned an invalid scan time');
    const stage = delyvaStage(status);
    const event: CarrierEvent & { time: string } = { time, ...wordingOf(text(row.description, 300, tenant), text(row.statusText, 120, tenant), status),
      provider_code: String(status), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return { index, event };
  }).sort((a, b) => Date.parse(b.event.time) - Date.parse(a.event.time) || a.index - b.index).map(({ event }) => event);

  const status = code(order.statusCode, tenant);
  const stage = (delyvaStage(status) ?? events.find((event) => event.stage)?.stage) as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  const destination = countryCode(text(order.destination, 200, tenant).split(',').at(-1));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: String(status),
    last_status_text: text(order.statusText, 120, tenant) || delyvaWording(status) || events[0]?.description || null,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...unreadEstimates({ arrival: order.arrival }),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}

/** Tracks a Delyva tenant's consignments through the platform's tracking service. */
export class DelyvaTracker {
  constructor(private readonly tenant: DelyvaTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    if (!GUID.test(tenant.companyId)) throw new TypeError(`${tenant.name}'s Delyva company id is not a GUID`);
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { provider, name } = this.tenant;
    const { response, bytes } = await fetchBounded(DELYVA_TRACK, {
      method: 'POST', signal, body: JSON.stringify(delyvaRequest(number, this.tenant)),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider, timeoutMs, maxBytes: DELYVA_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
    // A redirect, a missing route or an empty answer is a changed service, not a missing consignment.
    if (response.status !== 200) throw new TransportError(provider, `${name} tracking answered with HTTP ${response.status}`, { status: response.status });
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${name} tracking answered with a verification page`);
      throw new SchemaError(provider, `${name} answered with a page instead of its tracking reply`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(provider, `${name} returned a reply that is not JSON`, { cause: error });
    }
    return parseDelyva(payload, number, this.tenant);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDelyvaNumber(raw, this.tenant);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: this.tenant.provider, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}
