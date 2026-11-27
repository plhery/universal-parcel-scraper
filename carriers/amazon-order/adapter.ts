import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { readAmazonShareUrl } from '../../core/catalog/urls.js';
import { ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { paused } from '../../core/runner/pause.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MAX_BYTES, parseAmazonOrder, PROVIDER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// Amazon's robot check, and the AWS WAF challenge its sign-in pages answer with.
const CAPTCHA = /\/errors\/validateCaptcha|opfcaptcha|api-services-support@amazon\.com|awsWafCookieDomainList|\.awswaf\.com\//i;
// Amazon's robot check answers a run of requests from one address, then lets them through again.
export const RECHECK_PAUSE_MS = 10_000;
// The least time the request asked again after the pause still needs.
const RECHECK_FETCH_MS = 3_000;

// The share token is the parcel's only key: no error may carry the address.
function withoutCapability(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(PROVIDER, new Error('Amazon tracking link request failed'));
  return error;
}

export class AmazonOrderTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  fetch(number: string, trackingUrl: string, context: TrackingContext = {}): Promise<CarrierResult> {
    let link;
    try { link = readAmazonShareUrl(trackingUrl, number); }
    catch (error) { throw new InvalidInputError(PROVIDER, error instanceof Error ? error.message : 'Paste the complete Amazon tracking link'); }
    const { store, token, url } = link;
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let fetched;
      try {
        fetched = await fetchBounded(url, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.environment.userAgent) } },
          { provider: PROVIDER, timeoutMs, maxBytes: MAX_BYTES, fetcher: this.environment.fetcher, redirect: 'manual',
            allowHttpStatuses: [...REDIRECTS, 403, 404, 503] });
      } catch (error) { throw withoutCapability(error); }
      const { bytes, response } = fetched;
      if (REDIRECTS.includes(response.status)) {
        const location = response.headers.get('location') ?? '';
        if (CAPTCHA.test(location)) throw new ChallengeError(PROVIDER, 'Amazon asked for a captcha');
        // An unknown or expired token is sent to the order history and its sign-in.
        throw new IndeterminateError(PROVIDER, 'Amazon did not open the tracking link', { reason: 'session_rejected' });
      }
      const html = decodeText(bytes);
      if (CAPTCHA.test(html.slice(0, 200_000))) throw new ChallengeError(PROVIDER, 'Amazon asked for a captcha');
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Amazon refused the tracking page');
      if (response.status === 404) throw new IndeterminateError(PROVIDER, 'Amazon could not find the tracking page');
      if (response.status === 503) throw new UpstreamHttpError(PROVIDER, 503);
      if (!/progress-tracker/i.test(html)) throw new SchemaError(PROVIDER, 'Amazon returned a page other than its tracker');
      return parseAmazonOrder(html, token, store);
    };
    return runSteps({ carrier: 'amazon-order', budgetMs: context.budgetMs ?? 15000, signal: context.signal, recorder: this.environment.recorder }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
      { id: 'recheck', recovers: error => error instanceof ChallengeError,
        run: async ({ signal, remainingMs, previousError }) => {
          // A pause the lookup's end cuts short leaves the robot check as the answer.
          if (RECHECK_PAUSE_MS + RECHECK_FETCH_MS > remainingMs || !await paused(RECHECK_PAUSE_MS, signal)) throw previousError;
          return attempt(signal, remainingMs - RECHECK_PAUSE_MS);
        } },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AmazonOrderTracker(environment);
  return { id: 'amazon-order', recordsSteps: true, steps: ['direct', 'retry', 'recheck'], track: (input, context) => {
    if (!input.trackingUrl) throw new InputRequiredError(PROVIDER, 'trackingUrl', 'Amazon orders are tracked from the link of Amazon’s Share tracking button');
    return tracker.fetch(input.number, input.trackingUrl, context);
  } };
};
