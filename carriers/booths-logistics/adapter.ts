import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BOOTHS_MAX_BYTES, boothsHit, normalizeBoothsNumber, parseBooths, PROVIDER } from './parser.js';

export { boothsHit, normalizeBoothsNumber, parseBooths } from './parser.js';

const API = 'https://portal.booths.co.nz/OnEvent.BLL.Public.API/ConsignmentTrack';
/** The search the tracking results page runs for the number its form sends. */
export const BOOTHS_SEARCH = `${API}/ReferenceSearch`;
/** The consignment the details page opens from a search result. */
export const boothsConsignmentUrl = (id: number, containerId: number | null) => `${API}/${id}?containerId=${containerId ?? ''}`;
/** The results page, which gives every visitor the service's key in `trackTraceAjax.api_key`. */
export const BOOTHS_RESULTS_PAGE = 'https://www.booths.co.nz/services/tracking/results/';
// The key the results page gives every visitor, the same for everyone; it is read from the page again if the service refuses it.
export const BOOTHS_PAGE_KEY = '1ABC4A33-0FA3-4526-B7F7-39CDE12D0AB1'; // gitleaks:allow
const PAGE_KEY = /"api_key"\s*:\s*"([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})"/;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
// A block page a firewall in front of the site could give instead of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|Request blocked|<title>\s*(?:ERROR|403|Access Denied|Just a moment|Attention Required)/i;
const DEFAULT_BUDGET_MS = 20_000;

export class BoothsTracker {
  private key = BOOTHS_PAGE_KEY;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, key: string, signal: AbortSignal, deadline: number) {
    const { response, bytes } = await fetchBounded(url, { signal, headers: {
      Accept: 'application/json', 'Api-Key': key, Origin: 'https://www.booths.co.nz', Referer: BOOTHS_RESULTS_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, deadline - performance.now()), maxBytes: BOOTHS_MAX_BYTES,
      fetcher: this.options.fetcher, allowHttpStatuses: [401, 403] });
    const body = decodeText(bytes);
    const json = /^application\/json\b/i.test(response.headers.get('content-type') ?? '');
    if (response.status === 403 || (!json && CHALLENGE.test(body.slice(0, 64_000)))) {
      throw new ChallengeError(PROVIDER, 'Booth\'s tracker answered with a block page', { status: response.status });
    }
    return { status: response.status, json: response.status === 401 ? undefined : jsonOf(json, body) };
  }

  /** The key the results page gives its visitors now. */
  private async pageKey(signal: AbortSignal, deadline: number): Promise<string> {
    const { response, bytes } = await fetchBounded(BOOTHS_RESULTS_PAGE, { signal, headers: { 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs: Math.max(1, deadline - performance.now()), maxBytes: PAGE_MAX_BYTES, fetcher: this.options.fetcher,
        allowHttpStatuses: [403] });
    const page = decodeText(bytes);
    if (response.status === 403 || CHALLENGE.test(page.slice(0, 64_000))) {
      throw new ChallengeError(PROVIDER, 'Booth\'s results page answered with a block page', { status: response.status });
    }
    const key = PAGE_KEY.exec(page)?.[1];
    if (!key) throw new SchemaError(PROVIDER, 'Booth\'s results page no longer gives its tracking key');
    return key;
  }

  /** A read with the key; when the service refuses it, once more with the key the results page gives now. */
  private async keyed(url: string, signal: AbortSignal, deadline: number): Promise<unknown> {
    let answer = await this.get(url, this.key, signal, deadline);
    if (answer.status === 401) {
      const key = await this.pageKey(signal, deadline);
      if (key !== this.key) {
        this.key = key;
        answer = await this.get(url, key, signal, deadline);
      }
    }
    if (answer.status === 401) throw new TransportError(PROVIDER, 'Booth\'s tracker refused the key its results page gives', { status: 401 });
    return answer.json;
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const hit = boothsHit(await this.keyed(`${BOOTHS_SEARCH}?reference=${encodeURIComponent(number)}`, signal, deadline), number);
    return parseBooths(await this.keyed(boothsConsignmentUrl(hit.id, hit.containerId), signal, deadline), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBoothsNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

function jsonOf(json: boolean, body: string): unknown {
  if (!json) throw new SchemaError(PROVIDER, 'Booth\'s tracker answered with a page instead of its reply');
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new SchemaError(PROVIDER, 'Booth\'s tracker returned a reply that is not JSON', { cause: error });
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BoothsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
