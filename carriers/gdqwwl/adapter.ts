import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, normalizeQuanwangNumber, parseQuanwang, parseQuanwangForm, PROVIDER, QUANWANG_FORM, QUANWANG_ORIGIN, QUANWANG_PAGE_MAX_BYTES,
  QUANWANG_SERVICE,
} from './parser.js';

export { normalizeQuanwangNumber, parseQuanwang, parseQuanwangForm, QUANWANG_FORM, QUANWANG_SERVICE } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|Access denied|访问被拒绝/i;

/** A page that is not the tracker's: a bot check, an outage or a changed site. */
function unexpected(status: number, body: string, what: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Quanwang answered with a verification page', { status });
  if (status !== 200) throw new TransportError(PROVIDER, `Quanwang ${what} is unavailable`, { status });
  throw new SchemaError(PROVIDER, `Quanwang answered with something other than its ${what}`);
}

export class QuanwangTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeQuanwangNumber(raw);
    // An attempt that fails to reach the tracker, or hangs, gets one more: the first gets half of the budget,
    // so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.attempt(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.attempt(number, signal, remainingMs)),
    ]);
  }

  /**
   * One lookup as the tracker's form makes it: the form gives the references its button posts, and the post
   * carries them with the number and an empty name or phone. No session, account or captcha.
   */
  private async attempt(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' };
    const options = { provider: PROVIDER, redirect: 'manual' as const, fetcher: this.options.fetcher, maxBytes: QUANWANG_PAGE_MAX_BYTES,
      allowHttpStatuses: [...REDIRECTS, 403, 404, 429, 500, 502, 503] };

    const form = await fetchBounded(QUANWANG_FORM, { method: 'GET', signal, headers }, { ...options, timeoutMs: left() });
    const formBody = decodeText(form.bytes);
    if (form.response.status !== 200 || !formBody.includes('TB_FS_BG_Code')) unexpected(form.response.status, formBody, 'tracking form');
    const { viewState, action, source } = parseQuanwangForm(formBody);
    signal.throwIfAborted();

    const body = new URLSearchParams({ ViewState: viewState, Action: action, TB_FS_BG_Code: number, TB_FS_LK_Code: '', _Source_: source });
    const lookup = await fetchBounded(QUANWANG_SERVICE, { method: 'POST', signal, headers: { ...headers,
      'Content-Type': 'application/x-www-form-urlencoded', Origin: QUANWANG_ORIGIN, Referer: QUANWANG_FORM }, body: body.toString() },
    { ...options, timeoutMs: left() });
    const page = decodeText(lookup.bytes);
    if (lookup.response.status !== 200 || !page.includes('<title>网上单票_查货</title>')) unexpected(lookup.response.status, page, 'waybill page');
    return parseQuanwang(page, number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new QuanwangTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
