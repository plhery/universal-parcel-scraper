import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { accepted, recognizeFromLookup } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeOntracRequest, parseOntrac } from './parser.js';

// Endpoint and schema come from the current official portal client:
// https://www.ontrac.com/wp-content/themes/ontrac/assets/js/ontrac-package-status.js
const ENDPOINT = 'https://webtrack.ontrac.com/PackageServices/tracking/';

/** OnTrac's problem reply for a number it does not hold: `{"Title": "Not Found", "Status": 404, …}`. */
function unknownParcel(bytes: Uint8Array): boolean {
  try {
    const problem: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof problem === 'object' && problem !== null && (problem as Record<string, unknown>).Status === 404
      && (problem as Record<string, unknown>).Title === 'Not Found';
  } catch {
    return false;
  }
}

export class OntracTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeOntracRequest(raw);
    return runSteps({ carrier: 'ontrac', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`${ENDPOINT}${encodeURIComponent(number)}`, {
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) }, signal,
      }, { provider: 'OnTrac', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
      if (response.status === 404 || response.status === 410) {
        // The tracking route answers a number it does not hold with a typed "Not Found" problem; a route
        // that is gone answers an empty 404, and any other reply stays inconclusive.
        if (response.status === 404 && unknownParcel(bytes)) throw new NotFoundError('OnTrac');
        throw new IndeterminateError('OnTrac', 'OnTrac could not return the tracking resource');
      }
      return parseOntrac(parseJsonBytes(bytes, 'OnTrac'), number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OntracTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'ontrac', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeOntracRequest(number))) };
};
