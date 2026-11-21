import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import { CHALLENGE, HI_TRANS_MAX_BYTES, hiTransSummaryUrl, normalizeHiTransNumber, parseHiTrans, PROVIDER } from './parser.js';

export { HI_TRANS_SUMMARY, hiTransSummaryUrl } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];

export class HiTransTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHiTransNumber(raw);
    const url = hiTransSummaryUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HI_TRANS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 429] });
      const html = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403 || CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Hi-Trans Express answered with a browser check', { status: response.status });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Hi-Trans Express\'s consignment summary is unavailable', { status: response.status });
      return parseHiTrans(html, number);
    };
    // Cloudflare checks the summary's visitors, so a check the direct read meets goes to the
    // browser service. A read that fails to reach the site gets one more first.
    return runSteps({ carrier: 'hi-trans', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: HI_TRANS_MAX_BYTES, parse: html => parseHiTrans(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HiTransTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return {
    id: 'hi-trans', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
