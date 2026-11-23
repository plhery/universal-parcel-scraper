import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  captchaRejected, MAX_DETAILS, PROVIDER, TS_LINES_API, TS_LINES_MAX_BYTES, tsLinesBill, tsLinesCaptcha, tsLinesContainer, tsLinesHistory, tsLinesJson,
  tsLinesQuery, tsLinesResult, type TsLinesQuery,
} from './parser.js';

export { containerCheckDigit, tsLinesCaptchaCode, tsLinesQuery, tsLinesResult } from './parser.js';
export type { TsLinesQuery } from './parser.js';

/** The site the tracking page is served from, which its service expects as the origin. */
export const TS_LINES_SITE = 'https://www.tslines.com';
const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 15_000;
/** The answer to a search whose captcha code T.S. Lines refused. */
const REFUSED = Symbol('refused captcha');

type Call = (path: string, body?: Record<string, string>) => Promise<unknown>;

export interface TsLinesTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

export class TsLinesTracker {
  constructor(private readonly options: TsLinesTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = tsLinesQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('T.S. Lines budget must be positive');
    // A request that fails to reach T.S. Lines, or hangs, gets one more read, with new captchas.
    return runSteps<CarrierResult>({ carrier: 'ts-lines', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
    ]);
  }

  /**
   * As the tracking page asks: the container or bill search, then the moves of the container's
   * latest cycle under its bill, or of the bill's first containers.
   */
  private async read(query: TsLinesQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const call: Call = (path, body) => this.call(path, body, signal, deadline);
    const reply = await this.search(query, call);
    const cycles = query.kind === 'container'
      ? [tsLinesContainer(reply, query.number)].filter(cycle => cycle !== null)
      : tsLinesBill(reply, query.number) ?? [];
    const details = new Map<string, ReturnType<typeof tsLinesHistory>>();
    for (const { number, bill } of cycles.filter(cycle => cycle.bill !== null).slice(0, MAX_DETAILS)) {
      details.set(number, tsLinesHistory(await call('CargoTrackingHis', { BL_NUMBER: bill!, CONTAINER_NUMBER: number }), number));
    }
    return tsLinesResult(cycles, details);
  }

  /** The search, answered with the code of a new captcha; a code it refuses gets one more captcha. */
  private async search(query: TsLinesQuery, call: Call): Promise<unknown> {
    const [path, field] = query.kind === 'container' ? ['CargoTrackingByContainerNumber', 'CONTAINER_NUMBER'] : ['CargoTrackingByBLNumber', 'BL_NUMBER'];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const captcha = tsLinesCaptcha(await call('captcha'));
      const reply = await call(path, { [field]: query.number, CAPTCHA_TOKEN: captcha.token, CAPTCHA_CODE: captcha.code });
      if (reply !== REFUSED) return reply;
    }
    throw new ChallengeError(PROVIDER, 'T.S. Lines refused the captcha code twice', { reason: 'verification_refused' });
  }

  private async call(path: string, body: Record<string, string> | undefined, signal: AbortSignal, deadline: number): Promise<unknown> {
    const timeoutMs = Math.max(1, Math.min(REQUEST_LIMIT_MS, Math.floor(deadline - performance.now())));
    const headers: Record<string, string> = {
      Accept: 'application/json', Origin: TS_LINES_SITE, Referer: `${TS_LINES_SITE}/`, 'User-Agent': userAgentOf(this.options.userAgent),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
    const { response, bytes } = await fetchBounded(`${TS_LINES_API}/${path}`, { method: body ? 'POST' : 'GET', signal, headers, ...(body ? { body: JSON.stringify(body) } : {}) },
      { provider: PROVIDER, timeoutMs, maxBytes: TS_LINES_MAX_BYTES, fetcher: this.options.fetcher, allowHttpStatuses: [400, 404, 410] });
    // A missing route is a changed service, not a number T.S. Lines does not hold.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'T.S. Lines\' tracking service is unavailable', { status: response.status });
    const reply = tsLinesJson(decodeText(bytes));
    if (response.status === 400) {
      if (body?.CAPTCHA_CODE && captchaRejected(reply)) return REFUSED;
      throw new TransportError(PROVIDER, 'T.S. Lines refused the tracking request', { status: 400 });
    }
    return reply;
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new TsLinesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'ts-lines', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
