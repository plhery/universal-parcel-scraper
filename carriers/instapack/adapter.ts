import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  INSTAPACK_MAX_BYTES, INSTAPACK_TRACKING, instapackResultPath, isInstapackBlocked, normalizeInstapackNumber, parseInstapack,
  parseInstapackRefusal, PROVIDER,
} from './parser.js';

export { INSTAPACK_TRACKING, normalizeInstapackNumber, parseInstapack } from './parser.js';

const ORIGIN = 'https://back.instapack.es';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class InstapackTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async request(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<{ response: Response; html: string }> {
    const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: {
      ...init.headers as Record<string, string>, Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: INSTAPACK_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, 429, 503] });
    const { status } = response;
    const html = decodeText(bytes);
    if (status === 429) throw new RateLimitedError(PROVIDER);
    if (status === 403 || (status === 503 && isInstapackBlocked(html))) throw new ChallengeError(PROVIDER, 'Instapack refused the lookup', { status });
    if (status === 503) throw new MaintenanceError(PROVIDER, undefined, { status });
    if (GONE.includes(status)) throw new TransportError(PROVIDER, 'Instapack tracking is unavailable', { status });
    return { response, html };
  }

  /**
   * The form posted with the code. A known code is redirected to the parcel's signed page, read
   * next; an unknown one gets the form again with a message.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, deadline - performance.now());
    const posted = await this.request(INSTAPACK_TRACKING, { method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Referer: INSTAPACK_TRACKING,
    }, body: new URLSearchParams({ code: number }).toString() }, signal, left());
    if (posted.response.status === 200) parseInstapackRefusal(posted.html);
    const path = REDIRECTS.includes(posted.response.status) ? instapackResultPath(posted.response.headers.get('location')) : undefined;
    if (!path) throw new SchemaError(PROVIDER, 'Instapack sent the lookup somewhere other than a parcel’s page', { status: posted.response.status });
    const page = await this.request(`${ORIGIN}${path}`, { method: 'GET', headers: { Referer: INSTAPACK_TRACKING } }, signal, left());
    if (page.response.status !== 200) throw new SchemaError(PROVIDER, 'Instapack redirected the parcel’s page', { status: page.response.status });
    return parseInstapack(page.html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeInstapackNumber(raw);
    // A lookup that fails to reach Instapack, or hangs, starts again once: the first try gets
    // half of the budget. An HTTP status or a page is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: Instapack tracks the codes its senders give, marketplace numbers among them, and
// no detection rule offers it, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new InstapackTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
