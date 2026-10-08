
/**
 * AliExpress / Cainiao tracking.
 *
 * Cainiao's public shipment detail endpoint (`global.cainiao.com/global/
 * detail.json`) is the same keyless JSON the consumer tracking page reads. One
 * GET returns every requested `mailNo` as a module, so the adapter selects the
 * module whose identifier equals the number that was asked for and refuses
 * anything else: the endpoint happily echoes other shipments when the query is
 * malformed, and showing a stranger's parcel would be worse than an error.
 *
 * A module with no status, no history and no latest trace is genuinely unknown
 * only when `mailNoSource` is `EXTERNAL`; otherwise Cainiao is still waiting
 * for the seller and the parcel is simply pending.
 */
import { lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { validTrackingNumber } from '../../core/detection/valid.js';
import { ChallengeError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import {
  CAINIAO_ACTION_STATUS,
  CAINIAO_STATUS,
  cainiaoActionCode,
  cainiaoActionStage,
  cainiaoStageByStatus,
} from './status.js';

const PROVIDER = 'Cainiao';
const UPSTREAM = 'Cainiao tracking';
const DETAIL_URL = 'https://global.cainiao.com/global/detail.json';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_EVENTS_TO_RETURN = 100;
const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function comparableIdentifier(value: unknown): string {
  return text(value).toLocaleUpperCase('en-US').replace(/[^A-Z0-9]/g, '');
}

/**
 * The partner number Cainiao hands the parcel over with, when it publishes
 * one. `copyRealMailNo` is the machine-readable field; `realMailNo` is display
 * prose that sometimes wraps the same identifier in a sentence.
 */
function cainiaoHandoffNumber(trackingModule: JsonObject): string {
  const direct = normalizeTrackingNumber(text(trackingModule.copyRealMailNo));
  if (/^(?=.*\d)[A-Z0-9]{8,30}$/.test(direct)) {
    return direct;
  }
  const display = text(trackingModule.realMailNo);
  const match = /(?<![A-Z0-9])(?=[A-Z0-9]*\d)[A-Z0-9]{8,30}(?![A-Z0-9])/i.exec(display);
  return match?.[0].toUpperCase() ?? '';
}

/**
 * A scan's time: `timeStr` is the local wall clock and `timeZone` ("GMT+2")
 * its offset. `timeStr` alone is not UTC, and the epoch `time` field is not
 * the instant either: it reads `timeStr` as Beijing time even for European
 * scans, putting a morning "out for delivery" in the middle of the night
 * (checked 2026-09-22). Without a zone the text is kept, unless Cainiao
 * recorded the scan itself (`recordedInBeijing`).
 */
function scanTime(scan: JsonObject): string {
  const wall = text(scan.timeStr);
  const zone = /^(?:GMT|UTC)\s*(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(text(scan.timeZone));
  if (!wall) return wall;
  if (!zone) {
    if (text(scan.timeZone).trim() || !recordedInBeijing(scan, wall)) return wall;
    return explicitOffsetTime(`${wall.replace(' ', 'T')}+08:00`)?.iso ?? wall;
  }
  const offset = zone[1] ? `${zone[1]}${zone[2]!.padStart(2, '0')}:${zone[3] ?? '00'}` : 'Z';
  return explicitOffsetTime(`${wall.replace(' ', 'T')}${offset}`)?.iso ?? wall;
}

/** The carriers a module names, which a bracket can name too without being a place. */
function carrierNames(trackingModule: JsonObject, scans: readonly JsonObject[]): Set<string> {
  const named = [trackingModule.destCpInfo, ...[trackingModule.latestTrace, trackingModule.globalCombinedLogisticsTraceDTO, ...scans]
    .map((scan) => record(scan).currentStatusCpInfo)];
  return new Set(named.map((info) => text(record(info).cpName).trim().toLocaleLowerCase('en-US')).filter(Boolean));
}

/**
 * Cainiao has no place field: it writes a scan's town in front of its standard
 * wording, "[Bordeaux] Out for delivery", in every language. A bracket that
 * reads as a place name becomes the location and the wording keeps the rest.
 * Codes, ambiguous capitals-only names and the module's carrier names stay in the text.
 */
function placedWording(wording: string, carriers: ReadonlySet<string>): { description: string; location: string } {
  const match = /^\s*\[([^[\]]{1,80})\]\s*(\S[\s\S]*)$/.exec(wording);
  const place = match?.[1]!.trim() ?? '';
  // An explicit numbered city district is a place even in uppercase. Keep
  // arbitrary numbers and facility codes excluded from the general rule.
  const arrondissement = /^(?:Paris (?:[1-9]|1\d|20)|Lyon [1-9]|Marseille (?:[1-9]|1[0-6]))(?:er|e|eme|ème) arrondissement$/i.test(place);
  const letters = place.match(/\p{L}/gu)?.length ?? 0;
  if (!match || letters < 3 || (!arrondissement && (!/^\p{L}[\p{L}\p{M} .'’-]*$/u.test(place)
    || (/\p{Lu}/u.test(place) && !/\p{Ll}/u.test(place)))) || carriers.has(place.toLocaleLowerCase('en-US'))) {
    return { description: wording, location: '' };
  }
  return { description: match[2]!.trim(), location: place };
}

const BEIJING_OFFSET_MS = 8 * 3_600_000;

/**
 * Whether a zone-less scan is Cainiao's own record on the Beijing clock. Its
 * notices (`LAST_MILE_ASN_NOTIFY`, "Carrier update") come from no facility, so
 * they carry no `timeZone`, and their epoch keeps milliseconds that `timeStr`
 * cannot hold: the epoch is then the recorded instant and `timeStr` its
 * Beijing rendering, not the other way round. A whole-second epoch could be
 * read from the text, so it proves nothing.
 */
function recordedInBeijing(scan: JsonObject, wall: string): boolean {
  const epoch = scan.time;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch % 1000 === 0) return false;
  const beijing = new Date(epoch + BEIJING_OFFSET_MS);
  return Number.isFinite(beijing.getTime()) && beijing.toISOString().slice(0, 19).replace('T', ' ') === wall;
}

/** Projects one `detail.json` payload. Pure: the offline tests target this. */
export function parseCainiaoTrackingResponse(value: unknown, trackingNumber: string): CarrierResult {
  const payload = record(value);
  const rawModules = Array.isArray(payload.module)
    ? payload.module
    : Array.isArray(payload.data) ? payload.data : null;
  if (!rawModules) throw new SchemaError(PROVIDER, 'Cainiao returned an invalid tracking response');
  const modules = recordArray(rawModules);
  if (modules.length !== rawModules.length) {
    throw new SchemaError(PROVIDER, 'Cainiao returned an invalid shipment entry');
  }
  if (modules.length === 0) throw new SchemaError(PROVIDER, 'Cainiao did not return a shipment entry');
  const requested = comparableIdentifier(trackingNumber);
  const identified = modules.filter((module) => comparableIdentifier(module.mailNo));
  if (identified.length === 0) throw new SchemaError(PROVIDER, 'Cainiao did not return a shipment identifier');
  const trackingModule = identified.find(
    (module) => comparableIdentifier(module.mailNo) === requested,
  );
  if (!trackingModule) throw new SchemaError(PROVIDER, 'Cainiao returned a different shipment');
  const rawStatus = text(trackingModule.status);
  const latest = record(trackingModule.latestTrace ?? trackingModule.globalCombinedLogisticsTraceDTO);
  const rawDetails = trackingModule.detailList;
  if (rawDetails !== undefined && !Array.isArray(rawDetails)) {
    throw new SchemaError(PROVIDER, 'Cainiao returned invalid tracking history');
  }
  const details = recordArray(rawDetails);
  if (Array.isArray(rawDetails) && details.length !== rawDetails.length) {
    throw new SchemaError(PROVIDER, 'Cainiao returned an invalid tracking event');
  }
  if (Array.isArray(rawDetails)
    && !rawStatus
    && details.length === 0
    && Object.keys(latest).length === 0) {
    // Only an externally issued number can be positively unknown here; an
    // internal one is a shipment the seller has not handed over yet.
    if (text(trackingModule.mailNoSource).toLocaleUpperCase('en-US') === 'EXTERNAL') {
      throw new NotFoundError(PROVIDER);
    }
  }
  const status = cainiaoActionCode(latest.actionCode)
    ? (CAINIAO_ACTION_STATUS.get(cainiaoActionCode(latest.actionCode)) ?? 'unknown')
    : (CAINIAO_STATUS.get(rawStatus)
      ?? (rawStatus ? 'in_transit' : details.length === 0 ? 'pending' : 'unknown'));
  const latestAction = cainiaoActionCode(latest.actionCode);
  const currentStage = cainiaoActionStage(latestAction) ?? cainiaoStageByStatus()[status];
  const carriers = carrierNames(trackingModule, details);
  const events = details.slice(0, MAX_EVENTS_TO_RETURN).map((event): CarrierEvent => {
    const code = cainiaoActionCode(event.actionCode);
    const stage = cainiaoActionStage(code);
    const { description, location } = placedWording(text(event.standerdDesc) || text(event.desc), carriers);
    return {
      time: scanTime(event),
      location,
      description,
      // The code keys the app's review of a scan the map does not stage.
      ...(/^[A-Z0-9_]{1,64}$/.test(code) ? { provider_code: code } : {}),
      ...(stage ? { stage } : {}),
    };
  });
  const eta = record(trackingModule.globalEtaInfo);
  const toMillis = (value_: unknown): number | null => (
    typeof value_ === 'number' && Number.isFinite(value_) ? value_ : null
  );
  const deliveryMinTime = toMillis(eta.deliveryMinTime);
  const deliveryMaxTime = toMillis(eta.deliveryMaxTime);
  const toDate = (millis: number | null): string | null => (
    millis == null ? null : new Date(millis).toISOString().slice(0, 10)
  );
  const expected = toDate(deliveryMaxTime);
  const expectedFrom = toDate(deliveryMinTime);
  const handoff = cainiaoHandoffNumber(trackingModule);
  // Cainiao can follow the country with the recipient's town, "France,Town": only the country is read.
  const destination = text(trackingModule.destCountry).split(',')[0]!.trim().slice(0, 80);
  const deliveredAt = status === 'delivered' ? scanTime(latest) || null : null;
  return {
    status,
    ...(currentStage ? { current_stage: currentStage } : {}),
    last_status_text: placedWording(text(latest.standerdDesc) || text(latest.desc), carriers).description || rawStatus,
    last_update: scanTime(latest) || null,
    expected_delivery: status === 'delivered' ? null : expected,
    ...(status === 'delivered' || expectedFrom == null || expectedFrom === expected
      ? {}
      : { expected_delivery_from: expectedFrom }),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(handoff && comparableIdentifier(handoff) !== requested ? { delivery_tracking_number: handoff } : {}),
    ...(destination ? { destination_country_name: destination } : {}),
    events,
  };
}

/**
 * Alibaba's slider page, which Cainiao serves with a 200 in place of the JSON
 * once it suspects a robot.
 */
function sliderPage(body: string): boolean {
  return /^\s*</.test(body) && /rgv587_flag|<punish-component\b|\/_____tmd_____\//.test(body);
}

export class CainiaoTracker {
  private readonly fetcher: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}) {
    this.fetcher = options.fetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const budget = lookupBudget(context, this.timeoutMs);
    const { bytes } = await fetchBounded(
      `${DETAIL_URL}?${new URLSearchParams({ mailNos: trackingNumber, lang: 'en-US' })}`,
      {
        signal: budget.signal,
        headers: { ...BASE_HEADERS, 'User-Agent': this.userAgent, Referer: 'https://www.aliexpress.com/' },
      },
      { provider: UPSTREAM, timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()), fetcher: this.fetcher },
    );
    if (sliderPage(decodeText(bytes))) throw new ChallengeError(PROVIDER);
    return parseCainiaoTrackingResponse(parseJsonBytes(bytes, UPSTREAM), trackingNumber);
  }
}

/** Kept for the host's legacy dispatch chain until it is deleted. */
export async function fetchCainiao(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
  return new CainiaoTracker().fetch(trackingNumber, context);
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CainiaoTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'aliexpress',
    // One keyless GET; there is no second tier to fall back to.
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => validTrackingNumber(number)),
  };
};
