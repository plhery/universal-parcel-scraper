import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isLexshipBlocked, LEXSHIP_MAX_BYTES, lexshipJson, normalizeLexshipNumber, parseLexship, PROVIDER } from './parser.js';

export { normalizeLexshipNumber, parseLexship } from './parser.js';

/** LEXSHIP's tracking page, a script app that looks the number up from its `tracking` parameter. */
export const LEXSHIP_PAGE = 'https://track.lexship.biz/';
/** The lookup the tracking page's script makes for each number. */
export const LEXSHIP_API = 'https://live1.lexship.com/api/tracking/new';
const PAGE_MAX_BYTES = 64 * 1024;
// The page's script bundle is about a megabyte.
const SCRIPT_MAX_BYTES = 4 * 1024 * 1024;
const SCRIPT = /<script\b[^>]*\bsrc="(\/assets\/index-[\w-]+\.js)"/;
// The bearer token the script sends with each lookup, the same for every visitor. It expires,
// so it is read from the script the page serves rather than kept here.
const TOKEN = /"(eyJ[\w-]+\.[\w-]+\.[\w-]+)"/g;
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

/** The token the script writes nearest before its call to the lookup. */
export function lexshipPageToken(script: string): string | undefined {
  const call = script.indexOf(LEXSHIP_API);
  if (call < 0) return undefined;
  return [...script.slice(Math.max(0, call - 4_000), call).matchAll(TOKEN)].at(-1)?.[1];
}

export class LexshipTracker {
  private token: string | undefined;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, maxBytes: number, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: '*/*', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    const body = decodeText(bytes);
    if (response.status === 403) {
      throw new ChallengeError(PROVIDER, isLexshipBlocked(body) ? 'LEXSHIP answered with a browser check' : 'LEXSHIP refused its tracking page', { status: 403 });
    }
    if (response.status !== 200) throw new TransportError(PROVIDER, 'LEXSHIP tracking page is unavailable', { status: response.status });
    return body;
  }

  /** The visitor token, from the script the tracking page loads. */
  private async pageToken(signal: AbortSignal, deadline: number): Promise<string> {
    const page = await this.get(LEXSHIP_PAGE, PAGE_MAX_BYTES, signal, deadline - performance.now());
    const path = SCRIPT.exec(page)?.[1];
    if (!path) {
      if (isLexshipBlocked(page)) throw new ChallengeError(PROVIDER, 'LEXSHIP answered with a browser check');
      throw new SchemaError(PROVIDER, 'LEXSHIP tracking page no longer loads its script');
    }
    const token = lexshipPageToken(await this.get(new URL(path, LEXSHIP_PAGE).href, SCRIPT_MAX_BYTES, signal, deadline - performance.now()));
    if (!token) throw new SchemaError(PROVIDER, 'LEXSHIP tracking page no longer carries its lookup token');
    return token;
  }

  private async lookup(number: string, token: string, signal: AbortSignal, timeoutMs: number): Promise<{ status: number; body: string }> {
    const { response, bytes } = await fetchBounded(LEXSHIP_API, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      Origin: 'https://track.lexship.biz', Referer: LEXSHIP_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ awb_numbers: [{ parcel_id: number }] }) }, { provider: PROVIDER,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LEXSHIP_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 405, 410] });
    return { status: response.status, body: decodeText(bytes) };
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const cached = this.token;
    const token = cached ?? await this.pageToken(signal, deadline);
    this.token = token;
    let { status, body } = await this.lookup(number, token, signal, deadline - performance.now());
    if (status === 401 && cached) {
      // A token kept from an earlier lookup has expired: the page's current one is read once.
      this.token = undefined;
      const fresh = await this.pageToken(signal, deadline);
      this.token = fresh;
      ({ status, body } = await this.lookup(number, fresh, signal, deadline - performance.now()));
    }
    if (status === 401) {
      this.token = undefined;
      throw new ChallengeError(PROVIDER, 'LEXSHIP refused the tracking page\'s token', { status });
    }
    if (status === 403) {
      throw new ChallengeError(PROVIDER, isLexshipBlocked(body) ? 'LEXSHIP answered with a browser check' : 'LEXSHIP refused the lookup', { status });
    }
    // A redirect or a missing route is a moved lookup, never a missing shipment.
    if (status !== 200) throw new TransportError(PROVIDER, 'LEXSHIP tracking lookup is unavailable', { status });
    return parseLexship(lexshipJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLexshipNumber(raw);
    // A read that fails to reach LEXSHIP, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers LEXSHIP for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new LexshipTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
