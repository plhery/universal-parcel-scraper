/**
 * expressWeb (expressweb.co.kr), the tracker Korean forwarders share: each is a tenant by the
 * `fwdCode` its tracking links carry. The tracing page asks three services the bill's bound,
 * then its header, then its event list; this module asks them the same way for any tenant.
 */
import type { TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  EXPRESSWEB_BOUNDS, EXPRESSWEB_MAX_BYTES, EXPRESSWEB_MAX_ROWS, expresswebBound, expresswebHeader, normalizeExpresswebNumber,
  parseExpressweb, type ExpresswebTenant,
} from './parser.js';

export type { ExpresswebTenant } from './parser.js';

// The site answers plain HTTP only.
export const EXPRESSWEB_ORIGIN = 'http://expressweb.co.kr';
export const EXPRESSWEB_BOUND = `${EXPRESSWEB_ORIGIN}/common/selectGetTrackingBound.do`;
export const EXPRESSWEB_HEADER = `${EXPRESSWEB_ORIGIN}/common/selectTracingObjByLogin.do`;
export const EXPRESSWEB_EVENTS = `${EXPRESSWEB_ORIGIN}/common/selectTracingListByLogin.do`;
// The tracker words its rows in English, Korean (KOR) or Chinese (CHA); the codes are the same.
const LANGUAGE = 'ENG';
// The order the tracing page's table asks for, oldest first.
const ORDER = 'CONFIRMDATE ASC, CONFIRMTIME ASC, STATUSCODE';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|awswaf/i;
// The Tomcat session the first service opens, which the page's later requests carry.
const SESSION = /^JSESSIONID=[A-Za-z0-9._-]{1,128}(?=;|$)/;
const DEFAULT_BUDGET_MS = 20_000;

/** The tracing page a tenant's site opens for a bill, which looks the bill up as it loads. */
export function expresswebTrackingUrl({ fwdCode }: Pick<ExpresswebTenant, 'fwdCode'>, number: string): string {
  return `${EXPRESSWEB_ORIGIN}/member/loginTracing.do?${new URLSearchParams({ fwdCode, bound: 'ALL', langCode: 'KOR', HBLNO: number })}`;
}

export class ExpresswebTracker {
  constructor(
    private readonly tenant: ExpresswebTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {},
  ) {}

  /** One of the services, as the page's script asks it: a form post, answered with JSON. */
  private async post(url: string, form: URLSearchParams, session: string | undefined, signal: AbortSignal, timeoutMs: number) {
    const { provider, name } = this.tenant;
    const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, body: form.toString(), headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent), ...(session ? { Cookie: session } : {}),
    } }, { provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EXPRESSWEB_MAX_BYTES, redirect: 'manual',
      allowHttpStatuses: REDIRECTS, fetcher: this.options.fetcher });
    if (REDIRECTS.includes(response.status)) throw new TransportError(provider, `${name}'s tracker moved`, { status: response.status });
    const text = decodeText(bytes);
    // A page in place of the reply, such as the one an ended session gets, is not an answer about the bill.
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(provider, `${name}'s tracker answered with a browser check`);
      throw new SchemaError(provider, `${name}'s tracker answered with a page instead of its reply`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new SchemaError(provider, `${name}'s tracker returned a reply that is not JSON`, { cause: error });
    }
    const opened = response.headers.getSetCookie().map((cookie) => SESSION.exec(cookie)?.[0]).find(Boolean);
    return { payload, session: session ?? opened };
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const { fwdCode } = this.tenant;
    const bill = { DeliveryCode: '', HBLNO: number, PONO: '', REFNO: '' };
    const bound = await this.post(EXPRESSWEB_BOUND, new URLSearchParams({ params: JSON.stringify({ ...bill, tableTag: 'ALL', fwdCode }) }),
      undefined, signal, timeoutMs);
    const tableTag = expresswebBound(bound.payload, number, this.tenant);
    const tables = { ...bill, tableTag, ...EXPRESSWEB_BOUNDS[tableTag], langCode: LANGUAGE, fwdCode };
    const header = await this.post(EXPRESSWEB_HEADER, new URLSearchParams({ params: JSON.stringify(tables) }),
      bound.session, signal, deadline - Date.now());
    const { reference } = expresswebHeader(header.payload, number, this.tenant);
    // The event list takes the same keys as plain form fields, with the reference the header gives:
    // sent as `params` it fails with HTTP 500.
    const events = await this.post(EXPRESSWEB_EVENTS, new URLSearchParams({ ...tables, REFNO: reference, _search: 'false',
      rows: String(EXPRESSWEB_MAX_ROWS), page: '1', sidx: ORDER, sord: 'asc' }), header.session, signal, deadline - Date.now());
    return parseExpressweb({ bound: bound.payload, header: header.payload, events: events.payload }, number, this.tenant);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeExpresswebNumber(raw, this.tenant);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: this.tenant.provider, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}
