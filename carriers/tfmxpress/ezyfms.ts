/**
 * EzyFMS's FreightTrax tracker, `Tracker.asp` on IIS, which each carrier on the platform runs
 * under a path of its own on www.ezyfms.com (`/tfm/` for TFMXpress). Its form posts the
 * consignment number and an optional destination postcode, and the server renders the
 * consignment's rows. This module holds the request and the parser a tenant shares; each
 * carrier declares an `EzyFmsTenant`.
 */
import { load, type CheerioAPI } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';

/** One carrier's tenant of the tracker. */
export interface EzyFmsTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The tenant's path on www.ezyfms.com: `tfm` for `https://www.ezyfms.com/tfm/Tracker.asp`. */
  readonly path: string;
  /** The clock of the carrier's own network, for a depot no city in `depotZones` names. */
  readonly zone: string;
  /** Depots by name in lower case, each with its city's zone. Without it, the Australian cities below. */
  readonly depotZones?: Readonly<Record<string, string>>;
  /** A row's stage by its status wording, or null. */
  readonly stage: (wording: string) => ClassifiedWording | null;
  /** The carrier's map, which tells a row that moves nothing from one that moves the consignment. */
  readonly statusMap: CarrierStatusMap;
}

export const EZYFMS_ORIGIN = 'https://www.ezyfms.com';
// The sample's page is 23 kB.
export const EZYFMS_MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * Australian cities by the name a depot takes, each on its state's clock: the capitals, and the
 * cities the carriers on the platform run depots in. Queensland keeps standard time all year,
 * and Adelaide's clock is half an hour behind Melbourne's.
 */
export const AUSTRALIAN_DEPOT_ZONES: Readonly<Record<string, string>> = {
  adelaide: 'Australia/Adelaide', brisbane: 'Australia/Brisbane', canberra: 'Australia/Sydney', darwin: 'Australia/Darwin',
  'gold coast': 'Australia/Brisbane', hobart: 'Australia/Hobart', melbourne: 'Australia/Melbourne', newcastle: 'Australia/Sydney',
  perth: 'Australia/Perth', sydney: 'Australia/Sydney',
};

// Letters and digits with a digit, as long as the form's field takes.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,20}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|awswaf/i;
// "11/11/2024 08:05:39 AM": the depot's wall clock, day first.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):([0-5]\d):([0-5]\d) ([AP]M)$/i;
const ETA = /\bETA Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i;
// The notice the page gives in place of a consignment it does not know.
const NOT_FOUND = 'the tracking information is not available.';
const MAX_ROWS = 200;

/** The tenant's tracker, where its form posts. */
export const ezyFmsTrackerUrl = (tenant: EzyFmsTenant): string => `${EZYFMS_ORIGIN}/${tenant.path}/Tracker.asp`;

/** A consignment number as the tracker takes it: letters and digits with a digit, at most twenty. */
export function normalizeEzyFmsNumber(raw: string, tenant: EzyFmsTenant): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(tenant.provider, `${tenant.provider} consignment numbers are 4 to 20 letters and digits`);
  return number;
}

const invalid = (tenant: EzyFmsTenant, message: string): never => { throw new SchemaError(tenant.provider, message); };

/** A day the page writes day first, as `YYYY-MM-DD`, or null. */
function dayOf(day: string, month: string, year: string): string | null {
  return Number(year) >= 2000 ? calendarDay(Number(year), Number(month), Number(day)) : null;
}

/**
 * A row's wall clock, and its instant on the clock of the depot's city, else of the carrier's
 * network. The page states no zone; `time_zone_basis` says which was chosen.
 */
function clockOf(tenant: EzyFmsTenant, written: string, depot: string): Pick<CarrierEvent, 'time' | 'local_time' | 'time_zone' | 'time_zone_basis'> {
  const parts = CLOCK.exec(written);
  const day = parts ? dayOf(parts[1]!, parts[2]!, parts[3]!) : null;
  const twelve = parts ? Number(parts[4]) : 0;
  if (!parts || !day || twelve < 1 || twelve > 12) return invalid(tenant, `${tenant.provider} returned a row without a readable clock`);
  const hour = (twelve % 12) + (parts[7]!.toUpperCase() === 'PM' ? 12 : 0);
  const wall = `${day}T${String(hour).padStart(2, '0')}:${parts[5]}:${parts[6]}`;
  const city = (tenant.depotZones ?? AUSTRALIAN_DEPOT_ZONES)[depot.toLowerCase()];
  const zone = city ?? tenant.zone;
  const time = isoTime(wall, zone);
  if (!time) return invalid(tenant, `${tenant.provider} returned a row without a readable clock`);
  return { time: time.iso, local_time: wall, time_zone: zone, time_zone_basis: city ? 'place' : 'carrier' };
}

/** The columns of the page's table by their headings; the depot's is optional. */
function columns($: CheerioAPI, tenant: EzyFmsTenant): { count: number; clock: number; status: number; depot: number } {
  const headings = $('table#tblConsignmentTracking > thead th').toArray().map((cell) => clean($(cell).text(), 40).toLowerCase());
  const clock = headings.indexOf('datetime');
  const status = headings.indexOf('status');
  const depot = headings.indexOf('depot');
  if (clock < 0 || status < 0) return invalid(tenant, `${tenant.provider} changed its tracking table`);
  return { count: headings.length, clock, status, depot };
}

/**
 * The page the tracker renders for a consignment number posted as `CN`. The number comes back
 * only as the value of the form's `CN` field, which must be the whole number asked. A known
 * consignment gets its card, with the ETA date when there is one, and a table of its rows, oldest
 * first: a clock, a status, the depot and, on a pickup or delivery, the signature and the
 * signatory's name, which are not read. A number the tracker does not know gets "The tracking
 * information is not available." in place of the card.
 */
export function parseEzyFms(tenant: EzyFmsTenant, html: string, raw: string): CarrierResult {
  const number = normalizeEzyFmsNumber(raw, tenant);
  if (typeof html !== 'string' || !html) return invalid(tenant, `${tenant.provider} returned an empty page`);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(tenant.provider, `${tenant.provider} answered with a browser check`);
  const $ = load(html);
  const field = $('form#frmTracker input#CN[name="CN"]');
  if (field.length !== 1) return invalid(tenant, `${tenant.provider} returned a page without its tracking form`);
  if (normalizeTrackingNumber(clean(field.attr('value'), 64)) !== number) {
    throw new IndeterminateError(tenant.provider, `${tenant.provider} answered for another consignment`);
  }
  const card = $('#divDisplay');
  const table = $('table#tblConsignmentTracking');
  if (!card.length && !table.length) {
    if (clean($('#msg').text(), 120).toLowerCase() === NOT_FOUND) {
      throw new NotFoundError(tenant.provider, `${tenant.provider} has no consignment under this number`);
    }
    return invalid(tenant, `${tenant.provider} returned a page without a consignment`);
  }
  const eta = ETA.exec(clean(card.find('#LblReceiver').text(), 200));
  const expected = eta ? dayOf(eta[1]!, eta[2]!, eta[3]!) : null;
  const rows = table.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) return invalid(tenant, `${tenant.provider} returned too many rows`);
  if (!rows.length) throw new NoHistoryError(tenant.provider, `${tenant.provider} lists the consignment without a row`, { reason: 'listed' });

  const at = columns($, tenant);
  const events = rows.map((row): CarrierEvent => {
    const cells = $(row).children('td').toArray();
    if (cells.length !== at.count) return invalid(tenant, `${tenant.provider} returned an unreadable row`);
    const text = (index: number) => (index < 0 ? '' : clean($(cells[index]).text(), 200));
    const description = text(at.status);
    if (!description) return invalid(tenant, `${tenant.provider} returned a row without its status`);
    const depot = text(at.depot).slice(0, 80);
    const staged = tenant.stage(description);
    return { ...clockOf(tenant, text(at.clock), depot), description, ...(depot ? { location: depot } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  // The page lists the rows oldest first.
  }).reverse();

  const lead = leadingScan(events, tenant.statusMap);
  const stage = lead?.stage as Stage | undefined;
  const newest = events[0]!;
  // The delivery is the oldest of the delivered rows from the leading one down: the proof of
  // delivery is registered after it.
  let index = lead ? events.indexOf(lead) : -1;
  while (stage === 'delivered' && events[index + 1]?.stage === 'delivered') index += 1;
  const delivered = stage === 'delivered' ? events[index] : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time ?? null,
    expected_delivery: expected,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    events,
  };
}

export class EzyFmsTracker {
  constructor(private readonly tenant: EzyFmsTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const { tenant } = this;
    const number = normalizeEzyFmsNumber(raw, tenant);
    const url = ezyFmsTrackerUrl(tenant);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The form's fields, the postcode left empty: the tracker answers without one.
      const { response, bytes } = await fetchBounded(url, { method: 'POST', signal,
        body: new URLSearchParams({ CN: number, PC: '' }).toString(), headers: {
          Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded',
          Referer: url, 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: tenant.provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EZYFMS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 429] });
      if (response.status === 429) throw new RateLimitedError(tenant.provider);
      if (response.status === 401 || response.status === 403) {
        throw new ChallengeError(tenant.provider, `${tenant.provider} refused its guest request`, { status: response.status });
      }
      // An unknown number is HTTP 200 too; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(tenant.provider, `${tenant.provider} tracking page moved`, { status: response.status });
      return parseEzyFms(tenant, decodeText(bytes), number);
    };
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

/** A tenant's adapter: one lookup per number. */
export function ezyFmsAdapter(tenant: EzyFmsTenant): AdapterFactory {
  return (environment) => {
    const tracker = new EzyFmsTracker(tenant, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: tenant.carrier, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
    };
  };
}
