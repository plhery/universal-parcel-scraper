import { createHash } from 'node:crypto';
import type { TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';

/** The tracker Meest's sites frame. Its page carries the salt every lookup is signed with. */
export const MEEST_PAGE = 'https://t.meest-group.com/n/';
/** The lookup the page's script sends. */
export const MEEST_LOOKUP = 'https://t.meest-group.com/get.php';
const PAGE_MAX_BYTES = 1_000_000;
/** The page's salt changes from day to day; reuse it for less. */
const SALT_REUSE_MS = 60 * 60_000;
const DEFAULT_BUDGET_MS = 15_000;
// An edge block page instead of the tracker's page or XML.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied)|_cf_chl_opt|cf-turnstile|captcha|checking your browser|verify (?:that )?you are human|security verification|verification page/i;

/** The lookup refused a salt this tracker had kept: a fresh page brings the current one. */
class MeestSaltExpiredError extends IndeterminateError {
  constructor(provider: string) {
    super(provider, 'The guest tracker refused an expired lookup salt');
    this.name = 'MeestSaltExpiredError';
  }
}

/** The salt in the page's script, the same for every visitor until Meest changes it. */
export function meestPageSalt(html: string, provider = 'Meest'): string {
  const salt = /\bvar\s+salt\s*=\s*'([0-9a-f]{32})'/.exec(html)?.[1];
  if (salt) return salt;
  if (BLOCKED.test(html)) throw new ChallengeError(provider, 'The guest tracker refused its tracking page');
  throw new SchemaError(provider, 'The guest tracker changed its tracking page');
}

/**
 * The lookup for one number as the page's script sends it, signed with the MD5
 * of the salt, the number and the salt again. The server refuses any other
 * check. Without the page's `test` flag the rows come with older wording.
 */
export function meestLookupUrl(number: string, salt: string): string {
  const chk = createHash('md5').update(`${salt}${number}${salt}`).digest('hex');
  return `${MEEST_LOOKUP}?what=tracking&test&number=${encodeURIComponent(number)}&lang=uk&ext_track=&chk=${chk}`;
}

export class MeestPortalTracker {
  private salt?: { value: string; until: number };

  constructor(private readonly options: {
    carrier: string; provider: string; maxBytes: number;
    normalize: (raw: string) => string; parse: (xml: string, number: string) => CarrierResult;
    fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; networkOnlyRetry?: boolean; strictRoute?: boolean;
  }) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = this.options.normalize(raw);
    return runSteps({ carrier: this.options.carrier, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: step => this.lookup(number, step, false,
        this.options.networkOnlyRetry ? firstAttemptMs(step.remainingMs) : step.remainingMs) },
      ...(this.options.networkOnlyRetry ? [networkRetryStep<CarrierResult>(step => this.lookup(number, step, false))] : []),
      { id: 'refresh', recovers: error => error instanceof MeestSaltExpiredError, run: step => this.lookup(number, step, true) },
    ]);
  }

  private async lookup(number: string, step: StepContext, refresh: boolean, attemptMs = step.remainingMs): Promise<CarrierResult> {
    const deadline = performance.now() + Math.min(step.remainingMs, attemptMs);
    const timeoutMs = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    const kept = !refresh && this.salt && this.salt.until > Date.now() ? this.salt : undefined;
    let salt = kept?.value;
    if (!salt) {
      this.salt = undefined;
      const { response, bytes } = await fetchBounded(MEEST_PAGE, { signal: step.signal,
        headers: { Accept: 'text/html', 'User-Agent': userAgent } },
      { provider: this.options.provider, timeoutMs: timeoutMs(), maxBytes: PAGE_MAX_BYTES, fetcher: this.options.fetcher,
        redirect: this.options.strictRoute ? 'manual' : 'error',
        allowHttpStatuses: this.options.strictRoute ? [301, 302, 303, 307, 308, 404, 410] : [404, 410], retryTransient: !this.options.networkOnlyRetry, deadline });
      // A missing page is a moved tracker, not a missing parcel.
      if (!response.ok) throw new TransportError(this.options.provider, 'Meest tracking page is unavailable');
      this.checkRoute(response, MEEST_PAGE);
      if (this.options.strictRoute && BLOCKED.test(decodeText(bytes).slice(0, 64_000))) throw new ChallengeError(this.options.provider, 'The guest tracker returned verification');
      salt = meestPageSalt(decodeText(bytes), this.options.provider);
      this.salt = { value: salt, until: Date.now() + SALT_REUSE_MS };
    }
    // The page's script posts an empty form to the lookup.
    const { response, bytes } = await fetchBounded(meestLookupUrl(number, salt), { method: 'POST', signal: step.signal,
      headers: { Accept: 'application/xml, text/xml', 'User-Agent': userAgent } },
    { provider: this.options.provider, timeoutMs: timeoutMs(), maxBytes: this.options.maxBytes, fetcher: this.options.fetcher,
      redirect: this.options.strictRoute ? 'manual' : 'error',
      allowHttpStatuses: this.options.strictRoute ? [301, 302, 303, 307, 308, 400, 404, 410] : [400, 404, 410], retryTransient: !this.options.networkOnlyRetry, deadline });
    // The lookup answers a check made with any other salt with an empty 400.
    if (response.status === 400) {
      if (this.salt?.value === salt) this.salt = undefined;
      if (kept) throw new MeestSaltExpiredError(this.options.provider);
      throw new TransportError(this.options.provider, "Meest refused the check made with its own page's salt");
    }
    if (!response.ok) throw new TransportError(this.options.provider, 'Meest tracking lookup is unavailable');
    this.checkRoute(response, meestLookupUrl(number, salt));
    const xml = decodeText(bytes);
    if (!/^\s*<(?:\?xml|return\b)/.test(xml) && BLOCKED.test(xml.slice(0, 64_000))) {
      throw new ChallengeError(this.options.provider, 'Meest answered with a block page');
    }
    return this.options.parse(xml, number);
  }
  private checkRoute(response: Response, expected: string): void {
    if (!this.options.strictRoute) return;
    if (response.headers.get('cf-mitigated') === 'challenge') throw new ChallengeError(this.options.provider, 'The guest tracker returned verification');
    if (response.status !== 200 || (response.url && response.url !== expected)) throw new TransportError(this.options.provider, 'The guest tracker changed its route');
  }

}
