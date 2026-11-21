import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSekoNumber, parseSekoPage, PROVIDER, SEKO_MAX_BYTES, SEKO_SECTION } from './parser.js';

/** SEKO's tracking page, which its server renders for the numbers in the query. */
export const SEKO_PAGE = 'https://www.sekologistics.com/en/track/?trackingNumbers=';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the site, could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;
// The hosting's own page for a site its owner stopped, sent as HTTP 403.
const STOPPED = /<title>\s*Web App - Unavailable\s*<\/title>/i;

export class SekoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSekoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${SEKO_PAGE}${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SEKO_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'SEKO redirected its tracking page');
      const body = decodeText(bytes);
      const head = body.slice(0, 64_000);
      if (CHALLENGE.test(head) && !body.includes(SEKO_SECTION)) throw new ChallengeError(PROVIDER, 'SEKO answered with a browser check');
      if (response.status === 403) {
        if (STOPPED.test(head)) throw new MaintenanceError(PROVIDER, 'SEKO stopped its tracking site');
        throw new UpstreamHttpError(PROVIDER, 403);
      }
      // An unknown number is a page that says so; a missing page is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'SEKO tracking page is unavailable');
      return parseSekoPage(body, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'seko', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SekoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'seko', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSekoNumber(number))),
  };
};
