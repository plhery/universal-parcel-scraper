import { recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { isPostOneReference } from '../../core/detection/postOne.js';
import { ChallengeError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { MAX_BYTES, normalizePostOneNumber, parsePostOneTrackingHtml, postOneTrackingUrl, PROVIDER } from './parser.js';

export class PostOneTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePostOneNumber(raw), url = postOneTrackingUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal,
        headers: { Accept: 'text/html', 'Accept-Language': 'en-GB', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: MAX_BYTES, redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410, 428] });
      signal.throwIfAborted();
      if ([401, 403, 428].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge') {
        throw new ChallengeError(PROVIDER, 'Post One refused public tracking');
      }
      if (response.url && response.url !== url) throw new SchemaError(PROVIDER, 'Post One returned another tracking route');
      const location = response.headers.get('location');
      // A valid own-series query with no retained parcel redirects home without a body.
      // Other redirects and HTML interstitials are not evidence that the parcel is absent.
      if (response.status === 302 && bytes.byteLength === 0
        && (location === '/en' || location === `${new URL(url).origin}/en`)) {
        throw new NotFoundError(PROVIDER, 'Post One did not list this item');
      }
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Post One tracking is unavailable', { status: response.status });
      const type = response.headers.get('content-type') ?? '';
      if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) throw new SchemaError(PROVIDER, 'Post One returned no tracking HTML');
      return parsePostOneTrackingHtml(decodeText(bytes).replace(/^\uFEFF/, ''), number);
    };
    return runSteps({ carrier: 'post-one', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  async recognize(number: string, context: TrackingContext = {}): Promise<Recognition> {
    try {
      return await recognizeFromLookup(() => this.fetch(number, context), () => isPostOneReference(number));
    } catch (error) {
      if (error instanceof NoHistoryError && error.reason === 'parcel_found') return { known: true, lastActivityAt: null };
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PostOneTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'post-one', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context) };
};
