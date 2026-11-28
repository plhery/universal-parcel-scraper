import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { furtherAlong } from '../../core/status/progress.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { PackageLogsStatus } from './status.js';

// The package logs platform Greenway and The Human Express run their tracking pages on, each
// company on its own API host. The page posts the codes it is given as `{"codes": [...]}`; the
// service answers `packages`, one per code it holds, and `logs`, the history of all of them, each
// log naming its package by `package_id`. A code it holds none of is HTTP 400 with "Không tìm
// thấy" ("not found"), which Greenway's page reads as the codes not existing.

export const PACKAGE_LOGS_MAX_BYTES = 512_000;
export const PACKAGE_LOGS_UNKNOWN = 'Không tìm thấy';
// The tracking pages take letters and digits.
const NUMBER = /^[A-Z0-9]{6,40}$/;
const STATUS = /^[a-z][a-z-]{1,39}$/;
// The pages ask up to 40 codes at once.
const MAX_PACKAGES = 40;
const MAX_LOGS = 500;
// The platform writes an unset clock as the year 1.
const FIRST_CLOCK = Date.UTC(2001, 0, 1);
// The last-mile carrier a package names, `tracking.last_mile_carrier`, with the catalog's id.
const LAST_MILE: ReadonlyMap<string, string> = new Map([['USPS', 'usps']]);
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|captcha/i;

/** One company on the platform. */
export interface PackageLogsTenant {
  readonly carrier: string;
  readonly provider: string;
  /** The logs lookup its tracking page posts to. */
  readonly endpoint: string;
  /** Its tracking page, which the lookup names as origin and referrer. */
  readonly page: string;
  readonly status: PackageLogsStatus;
}

/** A code as the tracking pages send it: letters and digits in capitals. */
export function packageLogsNumber(raw: string, provider: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `${provider} codes are letters and digits`);
  return number;
}

/** The lookup's body for one code. */
export function packageLogsBody(number: string): string {
  return JSON.stringify({ codes: [number] });
}

function text(row: Record<string, unknown>, key: string, provider: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A clock the platform sets, or null for one it leaves unset. */
function setClock(value: unknown): string | null {
  const parsed = explicitOffsetTime(value);
  return parsed && parsed.timestamp >= FIRST_CLOCK ? parsed.iso : null;
}

/** The package whose code is the whole number asked; the pages read a code the reply leaves out as not existing. */
function packageOf(tenant: PackageLogsTenant, payload: unknown, number: string): { found: Record<string, unknown>; logs: unknown[] } {
  const { provider } = tenant;
  if (!isRecord(payload) || !Array.isArray(payload.packages) || !Array.isArray(payload.logs)) {
    throw new SchemaError(provider, `${provider} returned an invalid reply`);
  }
  if (payload.packages.length > MAX_PACKAGES || payload.logs.length > MAX_LOGS) throw new SchemaError(provider, `${provider} returned too many packages or logs`);
  if (!payload.packages.length) throw new NotFoundError(provider, `${provider} has no package under this code`);
  const found = payload.packages.filter((entry) => isRecord(entry) && isRecord(entry.package_code)
    && typeof entry.package_code.code === 'string' && normalizeTrackingNumber(entry.package_code.code) === number);
  if (found.length !== 1) throw new IndeterminateError(provider, `${provider} returned another package`);
  return { found: found[0] as Record<string, unknown>, logs: payload.logs };
}

/** The last-mile number a package names, and its carrier when that carrier's own rules take the number. */
function lastLeg(tenant: PackageLogsTenant, found: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (found.tracking === null || found.tracking === undefined) return {};
  if (!isRecord(found.tracking)) throw new SchemaError(tenant.provider, `${tenant.provider} returned an invalid tracking`);
  const onward = normalizeTrackingNumber(text(found.tracking, 'tracking_number', tenant.provider, 64));
  if (!NUMBER.test(onward) || onward === number) return {};
  const named = LAST_MILE.get(text(found.tracking, 'last_mile_carrier', tenant.provider, 40).toUpperCase());
  if (!named || !(detectCarrierMatch(onward).candidates as string[]).includes(named)) return { delivery_tracking_number: onward };
  return { delivery_carrier: named, delivery_tracking_number: onward };
}

/**
 * One package's history from the logs lookup, newest first. Each log is a `description`, a
 * `location` and a `ship_time` in UTC. `status_string` is the package's status, the tab the page
 * files it under, which gives the stage unless the newest staged log is further along; an alert
 * that the package was sent back gives `returned`. `country_code` is the destination, and
 * `tracking` the last-mile carrier and its number, which Greenway's page shows.
 */
export function parsePackageLogs(tenant: PackageLogsTenant, payload: unknown, raw: string): CarrierResult {
  const { provider, status: map } = tenant;
  const number = packageLogsNumber(raw, provider);
  const { found, logs } = packageOf(tenant, payload, number);
  if (typeof found.id !== 'number' && typeof found.id !== 'string') throw new SchemaError(provider, `${provider} returned a package without its id`);
  const code = text(found, 'status_string', provider, 40);
  if (code && !STATUS.test(code)) throw new SchemaError(provider, `${provider} returned an invalid package status`);
  const alert = found.alert ?? 0;
  if (!Number.isInteger(alert) || (alert as number) < 0 || (alert as number) > 99) throw new SchemaError(provider, `${provider} returned an invalid alert`);
  const leg = lastLeg(tenant, found, number);

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; at: number }[] = [];
  for (const row of logs) {
    if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid log`);
    if (String(row.package_id) !== String(found.id)) continue;
    const description = text(row, 'description', provider, 300);
    if (!description) continue;
    const at = explicitOffsetTime(row.ship_time);
    if (!at || at.timestamp < FIRST_CLOCK) throw new SchemaError(provider, `${provider} returned a log without its clock`);
    const location = text(row, 'location', provider, 200);
    const key = JSON.stringify([at.iso, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = map.logStage(description);
    scans.push({ at: at.timestamp, event: {
      time: at.iso, description, ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) {
    throw new NoHistoryError(provider, `${provider} lists the package without logs`, { reason: 'listed',
      ...(leg.delivery_carrier ? { deliveryCarrier: leg.delivery_carrier } : {}),
      ...(leg.delivery_tracking_number ? { deliveryTrackingNumber: leg.delivery_tracking_number } : {}) });
  }
  // Newest first, as the pages sort them; logs on one clock keep the reply's order.
  const events = scans.sort((left, right) => right.at - left.at).map(({ event }) => event);

  const returned = alert ? map.codeStage(`alert:${alert as number}`) : undefined;
  const summary = code ? map.codeStage(code) : undefined;
  const scan = leadingScan(events, map.statusMap);
  const fromScan = !returned && (!summary || furtherAlong(summary, scan?.stage));
  const stage = (returned ?? (fromScan ? scan?.stage : summary)) as Stage | undefined;
  const deliveredAt = stage === 'delivered' ? setClock(found.delivered_at) : null;
  const country = text(found, 'country_code', provider, 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: fromScan ? scan!.stage_source ?? 'carrier_map' : 'carrier_map' } : {}),
    ...(code ? { provider_code: code } : {}),
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time!,
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...leg,
    events,
  };
}

/** One reply of the logs lookup: a history, a code it does not hold, or a failure of its own kind. */
export function parsePackageLogsReply(tenant: PackageLogsTenant, status: number, body: string, raw: string): CarrierResult {
  const { provider } = tenant;
  if (status !== 200 && status !== 400) throw new TransportError(provider, `${provider} logs lookup is unavailable`, { status });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a verification page`, { cause });
    throw new SchemaError(provider, `${provider} answered with a page instead of its logs JSON`, { cause });
  }
  if (status === 400) {
    // Other refusals, such as "Please check input data", say nothing about the code.
    if (isRecord(payload) && typeof payload.error === 'string' && payload.error.trim() === PACKAGE_LOGS_UNKNOWN) {
      throw new NotFoundError(provider, `${provider} has no package under this code`);
    }
    throw new IndeterminateError(provider, `${provider} refused the lookup`);
  }
  return parsePackageLogs(tenant, payload, raw);
}

export interface PackageLogsOptions { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string }

export class PackageLogsTracker {
  constructor(private readonly tenant: PackageLogsTenant, private readonly options: PackageLogsOptions = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const { tenant } = this;
    const number = packageLogsNumber(raw, tenant.provider);
    return runSteps({ carrier: tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // The code alone, with no session, token or account.
      const { response, bytes } = await fetchBounded(tenant.endpoint, { method: 'POST', signal, body: packageLogsBody(number), headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json',
        Origin: new URL(tenant.page).origin, Referer: tenant.page, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: tenant.provider, fetcher: this.options.fetcher, maxBytes: PACKAGE_LOGS_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(remainingMs)), redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 400] });
      return parsePackageLogsReply(tenant, response.status, decodeText(bytes), number);
    } }]);
  }
}

/** The adapter of one company on the platform. */
export function packageLogsAdapter(tenant: PackageLogsTenant): AdapterFactory {
  return (environment) => {
    const tracker = new PackageLogsTracker(tenant, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: tenant.carrier, recordsSteps: true, steps: ['direct'],
      track: (input, context) => tracker.fetch(input.number, context),
      recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
        () => accepted(() => packageLogsNumber(number, tenant.provider))),
    };
  };
}
