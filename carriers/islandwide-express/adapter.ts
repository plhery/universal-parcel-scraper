import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeIslandwideNumber, parseIslandwide, PROVIDER, versionChanged } from './parser.js';

export { normalizeIslandwideNumber, parseIslandwide } from './parser.js';

/** The OutSystems app that islandwide.com's tracking page frames. */
const ORIGIN = 'https://preidi.outsystemsenterprise.com';
const MODULE_VERSION_URL = `${ORIGIN}/tracking/moduleservices/moduleversioninfo`;
const MODULE_INFO_URL = `${ORIGIN}/tracking/moduleservices/moduleinfo`;
/** The app's controller script, which names the action's API version; its path is its key in the module's manifest. */
const CONTROLLER_SCRIPT = '/Tracking/scripts/Tracking.controller.js';
export const ISLANDWIDE_ACTION_URL = `${ORIGIN}/tracking/screenservices/Tracking/ActionGetInformationbyTracking`;
// `callServerAction("GetInformationbyTracking", "screenservices/...", "<apiVersion>", inputs, ...)`.
const ACTION_VERSION = /callServerAction\("GetInformationbyTracking",\s*"screenservices\/Tracking\/ActionGetInformationbyTracking",\s*"([\w+/=-]{8,64})"/;
const TOKEN = /^[\w+/=-]{8,64}$/;
const SCRIPT_QUERY = /^\?[\w+/=-]{8,64}$/;
/**
 * The token OutSystems gives every anonymous visitor of a public app, in its runtime script and
 * its nr2Users cookie; the action refuses a request without it.
 */
const ANONYMOUS_CSRF_TOKEN = 'T6C+9iB49TLra4jEsMeSckDMNhQ='; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: an unknown one gets an empty list.
const GONE = [404, 405, 410];
const SCRIPT_MAX_BYTES = 1_000_000;

// A firewall or bot check's page, which can come back with HTTP 200 or 403.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;

const schema = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A reply's JSON; a bot check's page in its place is a challenge, any other page a changed app. */
function jsonOf(bytes: Uint8Array): unknown {
  const body = decodeText(bytes);
  try {
    return JSON.parse(body.replace(/^\uFEFF/, '')) as unknown;
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, "Islandwide's tracker answered with a browser check", { cause });
    throw new SchemaError(PROVIDER, "Islandwide's tracker answered with a page instead of JSON", { cause });
  }
}

/** What the request names of the app's current build: the module's version and the action's. */
interface Versions { moduleVersion: string; apiVersion: string }

export class IslandwideTracker {
  // The versions change when Islandwide deploys the app, and the action then says so.
  private versions: Versions | null = null;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeIslandwideNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const cached = this.versions;
      let payload = await this.lookUp(number, cached ?? await this.discover(signal, deadline), signal, deadline);
      // A deploy since the versions were read: read them again and ask once more.
      if (cached && versionChanged(payload)) {
        this.versions = null;
        payload = await this.lookUp(number, await this.discover(signal, deadline), signal, deadline);
      }
      if (versionChanged(payload)) this.versions = null;
      return parseIslandwide(payload, number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try: the first gets
    // half of the budget, so the retry fits in the rest. An HTTP status is never sent again.
    return runSteps({ carrier: 'islandwide-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  /** One request to the app, with a missing route or a redirect read as the app being unavailable. */
  private async request(url: string, init: RequestInit, signal: AbortSignal, deadline: number, maxBytes?: number) {
    const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: {
      'User-Agent': userAgentOf(this.options.userAgent), ...init.headers,
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, "Islandwide's tracker redirected a request", { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, "Islandwide's tracker is unavailable", { status: response.status });
    return { response, bytes };
  }

  private async json(url: string, signal: AbortSignal, deadline: number): Promise<unknown> {
    const { response, bytes } = await this.request(url, { method: 'GET', headers: { Accept: 'application/json' } }, signal, deadline);
    if (response.status === 403) throw new ChallengeError(PROVIDER, "Islandwide's tracker refused the request", { status: 403 });
    return jsonOf(bytes);
  }

  /**
   * The versions the app's page sends: the module's from moduleversioninfo, and the action's from
   * the controller script, whose address the module's manifest gives.
   */
  private async discover(signal: AbortSignal, deadline: number): Promise<Versions> {
    const info = await this.json(MODULE_VERSION_URL, signal, deadline);
    const moduleVersion = isRecord(info) && typeof info.versionToken === 'string' && TOKEN.test(info.versionToken) ? info.versionToken
      : schema("Islandwide's tracker returned no module version");
    // The token can hold + and /, which have to travel encoded.
    const module = await this.json(`${MODULE_INFO_URL}?${encodeURIComponent(moduleVersion)}`, signal, deadline);
    const urls = isRecord(module) && isRecord(module.manifest) && isRecord(module.manifest.urlVersions) ? module.manifest.urlVersions : {};
    const query = urls[CONTROLLER_SCRIPT];
    if (typeof query !== 'string' || !SCRIPT_QUERY.test(query)) return schema("Islandwide's tracker manifest does not list its controller");
    const { response, bytes } = await this.request(`${ORIGIN}${CONTROLLER_SCRIPT}${query}`, { method: 'GET', headers: { Accept: '*/*' } },
      signal, deadline, SCRIPT_MAX_BYTES);
    if (response.status === 403) throw new ChallengeError(PROVIDER, "Islandwide's tracker refused the request", { status: 403 });
    const apiVersion = ACTION_VERSION.exec(decodeText(bytes))?.[1] ?? schema("Islandwide's controller no longer names the lookup action");
    this.versions = { moduleVersion, apiVersion };
    return this.versions;
  }

  /** The action the page calls on load with the number in its address, for that one number. */
  private async lookUp(number: string, versions: Versions, signal: AbortSignal, deadline: number): Promise<unknown> {
    const { response, bytes } = await this.request(ISLANDWIDE_ACTION_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'X-CSRFToken': ANONYMOUS_CSRF_TOKEN },
      body: JSON.stringify({
        versionInfo: versions, viewName: 'MainFlow.Tracking',
        // The action reads the list; the page sends the number in both.
        inputParameters: { InTracking: number, TrackList: { List: [{ Tracking: number }] }, InTenantId: 0 },
      }),
    }, signal, deadline);
    if (response.status === 403) {
      // OutSystems answers a token it does not take with its own error; anything else is a block in front of it.
      const refusal = (() => {
        try {
          const body: unknown = JSON.parse(decodeText(bytes));
          return isRecord(body) && isRecord(body.exception);
        } catch {
          return false;
        }
      })();
      if (refusal) throw new SchemaError(PROVIDER, "Islandwide's tracker refused the anonymous visitor's token", { status: 403 });
      throw new ChallengeError(PROVIDER, "Islandwide's tracker refused the lookup", { status: 403 });
    }
    return jsonOf(bytes);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IslandwideTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'islandwide-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // The empty list is the tracker's answer for a number it does not hold: recognition reads it as unknown.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeIslandwideNumber(number))),
  };
};
