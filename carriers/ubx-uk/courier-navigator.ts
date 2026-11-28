import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { navigatorCode, navigatorStage, statusMap } from './status.js';

/** One courier's Courier Navigator site: the host its tracking page sends the search to. */
export interface NavigatorTenant {
  readonly carrier: CarrierId;
  readonly name: string;
  readonly host: string;
}

export const NAVIGATOR_MAX_BYTES = 1024 * 1024;
const DEFAULT_BUDGET_MS = 15_000;
// A missing or refused route is a moved search, never a missing parcel.
const GONE = [404, 405, 410];
const NUMBER = /^[A-Z0-9]{4,30}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
// The reply is a script the page runs: one call of its `trackingdownload` with the search's JSON.
const CALLBACK = /^\s*trackingdownload\s*\(([\s\S]*)\)\s*;?\s*$/;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const MAX_JOBS = 50;
const MAX_EVENTS = 500;
const MAX_KEPT = 100;
// What the page reads of the delivery address that can hold a slot or estimate.
const SLOT_FIELDS = ['eta', 'openETAWindow', 'closeETAWindow', 'openWindow', 'closeWindow', 'deadline'] as const;

/**
 * The carrier and link the page gives a job handed to another network, by the job's `link`, when the
 * reply sets no `trackurl` of its own; `%agentref%` stands for the job's forwarding reference. APC's
 * link names no parcel, and no catalog carrier is GLS Ireland.
 */
const LINKS: ReadonlyMap<string, { readonly carrier?: CarrierId; readonly url: string }> = new Map(Object.entries({
  'courier::dpdie': { carrier: 'dpd-ie', url: 'https://dpd.ie/tracking?consignmentNumber=%agentref%' },
  'courier::dpdieTest': { carrier: 'dpd-ie', url: 'https://dpd.ie/tracking?consignmentNumber=%agentref%' },
  'courier::dhl_XMLpi': { carrier: 'dhl-express', url: 'https://www.dhl.com/global-en/home/tracking.html?submit=1&tracking-id=%agentref%' },
  'courier::dhl_apiParcelUk': { carrier: 'dhl-ecommerce-uk', url: 'https://track.dhlparcel.co.uk/?con=%agentref%&nav=1' },
  'courier::gls': { url: 'https://gls-group.eu/IE/en/parcel-tracking.html?match=%agentref%' },
  'courier::ups': { carrier: 'ups', url: 'https://www.ups.com/track?loc=en_US&trackingNumber=%agentref%' },
  'courier::ups_api': { carrier: 'ups', url: 'https://www.ups.com/track?loc=en_US&trackingNumber=%agentref%' },
  'courier::anpost': { carrier: 'an-post', url: 'https://www.anpost.com/Commerce/Track/History?item=%agentref%' },
  'courier::fedexv13': { carrier: 'fedex', url: 'https://www.fedex.com/fedextrack/?action=track&trackingnumber=%agentref%' },
  'courier::apchorizon': { carrier: 'apc-overnight', url: 'https://apc-overnight.com/receiving-a-parcel/tracking' },
  'courier::interlink': { carrier: 'dpd-uk', url: 'https://apis.track.dpdlocal.co.uk/v1/track?parcel=%agentref%' },
  'courier::dpd': { carrier: 'dpd-uk', url: 'https://apis.track.dpd.co.uk/v1/track?parcel=%agentref%' },
  'courier::DXDMapi': { carrier: 'dx', url: 'https://my.dxdelivery.com/t/%agentref%' },
  'courier::DXDespatch': { carrier: 'dx', url: 'https://my.dxdelivery.com/t/%agentref%' },
  'courier::DXDespatchB2B': { carrier: 'dx', url: 'https://my.dxdelivery.com/t/%agentref%' },
  'courier::evriClassic': { carrier: 'evri-uk', url: 'https://www.evri.com/track/parcel/%agentref%/details' },
  'courier::royalMail': { carrier: 'royal-mail', url: 'https://www.royalmail.com/track-your-item#/tracking-results/%agentref%' },
} as Record<string, { carrier?: CarrierId; url: string }>));

/** The search endpoint of a tenant's site. */
export const navigatorEndpoint = (tenant: NavigatorTenant): string => `https://${tenant.host}/json/search/trackingdownload`;

/** The number as the search takes it: a consignment note, without spaces or dashes and in capitals. */
export function navigatorNumber(tenant: NavigatorTenant, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(tenant.carrier, `Invalid ${tenant.name} consignment number`);
  return number;
}

const folded = (value: unknown, maxLength = 64): string => {
  const text = cleanScalar(value, maxLength);
  return text ? normalizeTrackingNumber(text) : '';
};

/** The search's JSON out of the script the site answers with. */
function payloadOf(tenant: NavigatorTenant, body: string): Record<string, unknown> {
  const call = CALLBACK.exec(body);
  if (!call) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(tenant.carrier, `${tenant.name} answered with a browser check`);
    throw new SchemaError(tenant.carrier, `${tenant.name} answered without its tracking script`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(call[1]!);
  } catch (cause) {
    throw new SchemaError(tenant.carrier, `${tenant.name} returned an unreadable tracking script`, { cause });
  }
  if (!isRecord(payload)) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid tracking script`);
  return payload;
}

/**
 * An event's `time_stamp`, "2026-03-02 09:15:00", which the page reads as a wall clock with no
 * zone. Parsing in UTC checks the calendar only; the clock keeps no offset.
 */
function wallClock(tenant: NavigatorTenant, value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const [year, month, day, hour, minute, second] = match ? match.slice(1).map((part) => Number(part ?? 0)) : [];
  const parsed = match ? DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: 'UTC' }) : undefined;
  if (!parsed?.isValid || parsed.hour !== hour || parsed.day !== day) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid event time`);
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function eventOf(tenant: NavigatorTenant, row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid event`);
  const description = clean(row.description, 300);
  const code = navigatorCode(row.statusid);
  if (!description || code === undefined) throw new SchemaError(tenant.carrier, `${tenant.name} returned an event without wording or with an invalid status`);
  const local_time = wallClock(tenant, row.time_stamp);
  const staged = navigatorStage(code || null, description);
  return {
    local_time, description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

// The carrier is named when the forwarding reference has its shape, or when, for a carrier without
// number rules, the link the page opens names that carrier for the same number.
function partnerShape(partner: string, reference: string, link: string): boolean {
  if ((detectCarrierMatch(reference).candidates as string[]).includes(partner)) return true;
  if (CARRIER_DEFINITIONS[partner as CarrierId]?.detectionRules.length !== 0) return false;
  const linked = parseTrackingInput(link);
  return linked.source === 'link' && linked.carrier === partner && linked.trackingNumber === reference;
}

/**
 * A job handed to another network: the page shows its `agentref` as the forwarding reference and a
 * button to that network's tracker, the reply's `trackurl` or the one the page keeps for the job's
 * `link`. The link is never followed.
 */
function handoff(tenant: NavigatorTenant, job: Record<string, unknown>, own: readonly string[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = folded(job.agentref);
  if (!REFERENCE.test(reference)) return {};
  const listed = LINKS.get(clean(job.link, 80));
  const trackurl = clean(job.trackurl, 500);
  const link = (trackurl || listed?.url || '').replace('%agentref%', reference);
  const carrier = trackurl ? carrierIdFromPartner(clean(job.trackurltitle, 80).replace(/^track with\s+/i, ''), link) : listed?.carrier;
  const named = carrier && carrier !== tenant.carrier && partnerShape(carrier, reference, link);
  return {
    ...(named ? { delivery_carrier: carrier } : {}),
    // The number asked or the job's own is no second reference.
    ...(own.includes(reference) ? {} : { delivery_tracking_number: reference }),
  };
}

/** The delivery address's slot fields this reply fills, which the adapter does not read. */
function slots(job: Record<string, unknown>): Pick<CarrierResult, 'unread_estimates'> {
  const addresses = isRecord(job.addresses) && Array.isArray(job.addresses.address) ? job.addresses.address as unknown[] : [];
  const delivery = addresses.filter((address): address is Record<string, unknown> => isRecord(address) && address.type === 'delivery');
  return unreadEstimates(Object.fromEntries(SLOT_FIELDS.map((field) => [`addresses.address.${field}`, delivery.find((address) => address[field] != null)?.[field]])));
}

/**
 * The reply of `POST /json/search/trackingdownload` on a tenant's Courier Navigator host, the search
 * its tracking page makes with the number as `consign_note`: `trackingdownload({...})` with the jobs
 * found and the search asked. A job's `consign_note` is the page's heading, its `events` the timeline,
 * oldest first, and its `agentref` and `link` the forwarding reference and its network. An empty job
 * list is the page's "It has not been possible to find a matching consignment". The job must be the
 * number asked, by its consignment note or its job id. Event details, signatures and addresses are
 * not read.
 */
export function parseNavigator(tenant: NavigatorTenant, body: string, raw: string): CarrierResult {
  const number = navigatorNumber(tenant, raw);
  const payload = payloadOf(tenant, body);
  if (Array.isArray(payload.error) && payload.error.length) throw new IndeterminateError(tenant.carrier, `${tenant.name} refused the search`);
  if (!Array.isArray(payload.jobs) || payload.jobs.length > MAX_JOBS) throw new SchemaError(tenant.carrier, `${tenant.name} returned no job list`);
  if (!payload.jobs.length) {
    const asked = isRecord(payload.request) ? folded(payload.request.consign_note) : '';
    if (asked !== number) throw new IndeterminateError(tenant.carrier, `${tenant.name} answered another search`);
    throw new NotFoundError(tenant.carrier);
  }
  const job = (payload.jobs as unknown[]).find((entry): entry is Record<string, unknown> => isRecord(entry)
    && (folded(entry.consign_note) === number || folded(entry.jobid) === number));
  if (!job) throw new IndeterminateError(tenant.carrier, `${tenant.name} answered for another consignment`);
  const partner = handoff(tenant, job, [number, folded(job.consign_note), folded(job.jobid)]);
  const rows = job.events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_EVENTS) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid timeline`);
  if (!rows.length) {
    throw new NoHistoryError(tenant.carrier, `${tenant.name} lists the consignment without events`, { reason: 'listed',
      deliveryCarrier: partner.delivery_carrier, deliveryTrackingNumber: partner.delivery_tracking_number });
  }

  const scans: { event: CarrierEvent; index: number }[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const event = eventOf(tenant, row);
    const key = JSON.stringify([event.local_time, event.provider_code, event.description]);
    if (!seen.has(key)) { seen.add(key); scans.push({ event, index }); }
  }
  // Newest first by wall clock, as the page shows them; events on one clock keep the reply's order, reversed.
  const clock = (event: CarrierEvent) => event.local_time as string;
  const events = scans.sort((left, right) => (clock(left.event) === clock(right.event) ? right.index - left.index
    : clock(left.event) < clock(right.event) ? 1 : -1)).map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source! } : {}),
    last_status_text: newest.description!,
    ...(newest.provider_code ? { provider_code: newest.provider_code } : {}),
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...partner,
    ...(stage === 'delivered' ? {} : slots(job)),
    events: events.slice(0, MAX_KEPT),
    ...(events.length > MAX_KEPT ? { history_truncated: true } : {}),
  };
}

/** The adapter of one Courier Navigator tenant: one search on its host, bound to the number asked. */
export const courierNavigatorAdapter = (tenant: NavigatorTenant): AdapterFactory => (environment) => ({
  id: tenant.carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = navigatorNumber(tenant, input.number);
    return runSteps({ carrier: tenant.carrier, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: environment.recorder }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(navigatorEndpoint(tenant), { method: 'POST', signal, headers: {
        Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': userAgentOf(environment.userAgent),
      }, body: new URLSearchParams({ consign_note: number }).toString() }, {
        provider: tenant.carrier, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: NAVIGATOR_MAX_BYTES,
        allowHttpStatuses: GONE, fetcher: environment.fetcher,
      }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      if (GONE.includes(response.status)) throw new TransportError(tenant.carrier, `${tenant.name} tracking search is unavailable`, { status: response.status });
      return parseNavigator(tenant, decodeText(bytes), number);
    } }]);
  },
});
