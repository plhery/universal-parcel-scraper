import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { discoverActionId } from './action.js';
import { isChallengePage, M24_MAX_BYTES, normalizeM24Number, parseM24, PROVIDER, readActionReply, UnknownActionError } from './parser.js';

/** M24's order page; its server action looks the order up for the reference in the path. */
export const M24_PAGE = 'https://lms.m24logistics.com/track-my-order/';
/**
 * The id of the page's order lookup, tried first. Every visitor's page carries
 * the same one until the site is built again; when the tracker no longer knows
 * it, the lookup reads the current one from the page's chunks.
 */
export const M24_ACTION = 'f97445adc1e5201f8eb8253fe0b9e4d3dc4424f9';
// The page is about fifteen kilobytes, and each of its chunks under three hundred.
const PAGE_MAX_BYTES = 600_000;
const CHUNK_MAX_BYTES = 1_000_000;
/** How long an id read from the page stays the first try after it last answered. */
const ACTION_TTL_MS = 6 * 3_600_000;
const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [404, 405, 410];
// The tracker fails a reference it holds no order for with a bare server error, as it does any other failure.
const SERVER_ERROR = 500;

export class M24Tracker {
  // An id the page named and the tracker then answered, for the lookups after it.
  private discovered: { id: string; until: number } | undefined;

  constructor(private readonly options: {
    fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string;
    /** The id tried first when none read from the page is current; the built-in one by default. */
    action?: string;
  } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeM24Number(raw);
    const page = `${M24_PAGE}${encodeURIComponent(number)}`;
    const cached = this.discovered && this.discovered.until > Date.now() ? this.discovered.id : undefined;
    let action = cached ?? this.options.action ?? M24_ACTION;
    let stale = false;

    const refresh = async (signal: AbortSignal, deadline: number) => {
      const html = await this.get(page, signal, deadline, PAGE_MAX_BYTES);
      const found = await discoverActionId(html, page, url => this.get(url, signal, deadline, CHUNK_MAX_BYTES));
      if (found === undefined) throw new SchemaError(PROVIDER, 'M24 Logistics order page no longer names its lookup: the tracking lookup changed');
      // The page naming the id that just failed means the id is not what changed.
      if (found === action) throw new SchemaError(PROVIDER, 'M24 Logistics did not answer its own lookup: the tracking lookup changed');
      action = found;
      stale = false;
    };

    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      if (stale) await refresh(signal, deadline);
      const id = action;
      try {
        const result = await this.post(page, number, id, signal, deadline);
        this.remember(id);
        return result;
      } catch (error) {
        if (error instanceof UnknownActionError) {
          stale = true;
          if (id === cached) this.discovered = undefined;
        }
        throw error;
      }
    };

    // The first try gets half of the budget, so a retry fits in the rest. An
    // action the tracker no longer has is read again from the page and tried
    // once more; a lookup that fails to reach M24, or hangs, gets one retry.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      { id: 'action', recovers: error => error instanceof UnknownActionError,
        run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }

  private remember(id: string): void {
    if (id !== M24_ACTION) this.discovered = { id, until: Date.now() + ACTION_TTL_MS };
  }

  private async post(page: string, number: string, action: string, signal: AbortSignal, deadline: number): Promise<CarrierResult> {
    // The page calls its action with the reference in its path, as a one-item argument list.
    const { response, bytes } = await fetchBounded(page, { method: 'POST', signal, headers: {
      Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': action,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify([number]) }, { provider: PROVIDER, timeoutMs: timeLeft(deadline), maxBytes: M24_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, ...UNAVAILABLE, SERVER_ERROR] });
    // Next answers an action it does not have with 404 and this header, or with the page itself.
    if (response.headers.has('x-nextjs-action-not-found')) throw new UnknownActionError();
    if (response.status === 403) {
      if (isChallengePage(decodeText(bytes))) throw new ChallengeError(PROVIDER, 'M24 Logistics answered with a browser check');
      throw new ChallengeError(PROVIDER, 'M24 Logistics refused the lookup', { status: 403 });
    }
    if (REDIRECTS.includes(response.status) || UNAVAILABLE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'M24 Logistics tracking lookup is unavailable', { status: response.status });
    }
    if (response.status === SERVER_ERROR) {
      if (isChallengePage(decodeText(bytes))) throw new ChallengeError(PROVIDER, 'M24 Logistics answered with a browser check');
      throw new UpstreamHttpError(PROVIDER, SERVER_ERROR);
    }
    return parseM24(readActionReply(bytes, response.headers.get('content-type')), number);
  }

  /** The page or one of its chunks, as text. */
  private async get(url: string, signal: AbortSignal, deadline: number, maxBytes: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: url.endsWith('.js') ? '*/*' : 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: timeLeft(deadline), maxBytes, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 403, ...UNAVAILABLE] });
    const text = decodeText(bytes);
    if (response.status === 403 || (/^\s*</.test(text) && isChallengePage(text))) {
      throw new ChallengeError(PROVIDER, 'M24 Logistics answered its order page with a browser check');
    }
    if (response.status !== 200) throw new TransportError(PROVIDER, 'M24 Logistics order page is unavailable', { status: response.status });
    return text;
  }
}

const timeLeft = (deadline: number) => Math.max(1, Math.floor(deadline - performance.now()));

export const adapter: AdapterFactory = (environment) => {
  const tracker = new M24Tracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'action', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
