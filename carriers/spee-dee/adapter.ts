import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpeeDeeNumber, parseSpeeDee } from './parser.js';

const PROVIDER = 'Spee-Dee';
// The website's detail page (packageDetail.php) redirects here.
const PROGRESS = 'https://packages.speedeedelivery.com/package_progress.php';
// The page has carried a debug dump in an HTML comment for each scan, up to
// several kilobytes apiece. The parser drops them, but they count against this cap.
const MAX_BYTES = 256 * 1024;
// The host drops connections from some networks without answering. A short
// cap keeps such a request from holding the caller's whole budget.
const REQUEST_TIMEOUT_MS = 10_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// A connection dropped or refused.
const UNANSWERED_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']);
const UNANSWERED = 'unanswered';

export function speeDeeProgressUrl(raw: string): string {
  return `${PROGRESS}?${new URLSearchParams({ v: 'detail', barcode: normalizeSpeeDeeNumber(raw) })}`;
}

/**
 * Whether a request without a reply failed the way the host fails networks it
 * filters: a connection dropped or refused, or nothing within the request
 * limit. A failed name lookup or a bad certificate is another fault.
 */
function droppedOrRefused(error: unknown, depth = 0): boolean {
  if (depth > 8 || !(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || UNANSWERED_CODES.has(String((error as { code?: unknown }).code))) return true;
  const inner: unknown[] = error instanceof AggregateError ? error.errors : [];
  return [...inner, error.cause].some((next) => droppedOrRefused(next, depth + 1));
}

/**
 * Whether a lookup failed because the host never answered. A reply that
 * starts and then breaks or stalls is a plain transport failure instead.
 */
export function speeDeeUnanswered(error: unknown): boolean {
  return error instanceof TransportError && error.reason === UNANSWERED;
}

export class SpeeDeeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpeeDeeNumber(raw);
    return runSteps({ carrier: 'spee-dee', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      let fetched: Awaited<ReturnType<typeof fetchBounded>>;
      // Set once the status and headers arrive. A body that then breaks or
      // stalls is a broken reply, not a filtered network.
      let answered = false;
      const fetcher: typeof fetch = async (input, init) => {
        const response = await (this.options.fetcher ?? fetch)(input, init);
        answered = true;
        return response;
      };
      try {
        fetched = await fetchBounded(speeDeeProgressUrl(number), { signal, headers: {
          'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html',
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Math.floor(remainingMs))),
          maxBytes: MAX_BYTES, redirect: 'manual', allowHttpStatuses: REDIRECTS, fetcher });
      } catch (error) {
        if (signal.aborted) throw error;
        // A missing page or a host that does not answer says nothing about the package.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Spee-Dee tracking page is unavailable', { cause: error });
        }
        if (!answered && error instanceof UpstreamNetworkError && droppedOrRefused(error)) {
          throw new TransportError(PROVIDER, 'Spee-Dee did not answer; its host refuses some networks',
            { cause: error, reason: UNANSWERED });
        }
        throw error;
      }
      if (REDIRECTS.includes(fetched.response.status)) throw new SchemaError(PROVIDER, 'Spee-Dee tracking page moved');
      return parseSpeeDee(decodeText(fetched.bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpeeDeeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'spee-dee', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
