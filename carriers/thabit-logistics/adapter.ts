import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { normalizeThabitNumber, parseThabit, PROVIDER, THABIT_MAX_BYTES, thabitTrackingUrl } from './parser.js';

export class ThabitTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder; trawl?: TrawlClient | null } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeThabitNumber(raw), url = thabitTrackingUrl(number);
    return runSteps({ carrier: 'thabit-logistics', signal: context.signal,
      budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: async ({ signal, remainingMs }) => {
        const reply = await fetchBounded(url, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
          provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs,
          maxBytes: THABIT_MAX_BYTES, redirect: 'error', allowHttpStatuses: [403, 404, 406, 410] });
        if (reply.response.status === 403 || reply.response.status === 406) throw new ChallengeError(PROVIDER, 'Thabit refused the public tracking page', { status: reply.response.status });
        if (reply.response.status !== 200) throw new TransportError(PROVIDER, 'Thabit tracking is unavailable', { status: reply.response.status });
        return parseThabit(decodeText(reply.bytes), number);
      } },
      trawlPageStep({ ...this.options, url, provider: PROVIDER, maxBytes: THABIT_MAX_BYTES, parse: html => parseThabit(html, number) }),
    ]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new ThabitTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder, trawl: environment.trawl });
  return { id: 'thabit-logistics', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
