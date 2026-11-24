import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeDragonflyAuNumber, parseDragonflyAu } from './parser.js';

const PROVIDER = 'Dragonfly Australia';
// The Australian Dragonfly portal's own tracking service: the Canadian contract on a separate backend.
const ENDPOINT = 'https://dragonflyshipping.com.au/cfworker/v3/tracking/';
// A Cloudflare page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes).replace(/^\uFEFF/, '');
  try {
    return JSON.parse(body);
  } catch (error) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Dragonfly Australia answered with a Cloudflare page', { cause: error });
    throw new SchemaError(PROVIDER, 'Dragonfly Australia returned a reply that is not JSON', { cause: error });
  }
}

export class DragonflyAuTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDragonflyAuNumber(raw);
    return runSteps({ carrier: 'dragonfly-au', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(`${ENDPOINT}${number}/`, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
          { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        return parseDragonflyAu(json(bytes), number);
      } catch (error) {
        // An unknown number gets HTTP 200 with the service's own not_found code, never a 404.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError(PROVIDER, 'Dragonfly Australia tracking endpoint is unavailable', { cause: error });
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DragonflyAuTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dragonfly-au', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
