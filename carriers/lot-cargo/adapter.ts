import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeLotCargoNumber, parseLotCargoTracking, provider } from './parser.js';

const tracker = 'https://cargo-tracking.lot.com/';
const search = 'https://api.lot.com/cargo/parcel/search';
// The public tracker's script gives every visitor this key; its page adds a short-lived token.
const apiKey = 'Pap1jHwWcQ4QVDmXn5ljV7IihNEkQeWhabz62sns'; // gitleaks:allow
const verification = /<title>\s*(?:Access Denied|Just a moment|Attention Required)|cf-chl|_Incapsula_Resource|\/_sec\/cp_challenge/i;

/** The bearer token the tracker's page writes into a script for its own requests. */
export function pageToken(html: string): string {
  const token = /\baccess_token:\s*"([\w.-]{20,})"/.exec(html)?.[1];
  const type = /\btoken_type:\s*"(\w+)"/.exec(html)?.[1];
  if (!token || type !== 'Bearer') {
    if (verification.test(html)) throw new ChallengeError(provider, 'LOT Cargo returned a verification page');
    throw new SchemaError(provider, 'The LOT Cargo tracker no longer gives its page a token');
  }
  return token;
}

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeLotCargoNumber(input.number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const userAgent = userAgentOf(environment.userAgent);
        const read = async (url: string, headers: Record<string, string>, allowHttpStatuses: number[]) => {
          signal.throwIfAborted();
          const left = Math.floor(deadline - performance.now());
          if (left <= 0) throw new BudgetExceededError(provider, remainingMs);
          try {
            const { response, bytes } = await fetchBounded(url, { signal, headers: { ...headers, 'User-Agent': userAgent } }, {
              provider, fetcher: environment.fetcher, timeoutMs: left, maxBytes: 600_000, allowHttpStatuses,
            });
            return { status: response.status, body: decodeText(bytes) };
          } catch (error) {
            // The shared diagnostics would carry the page's token.
            if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
            if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
            throw error;
          }
        };

        const page = await read(tracker, { Accept: 'text/html' }, [403]);
        if (page.status === 403) throw new ChallengeError(provider, 'LOT Cargo refused its tracking page');
        const token = pageToken(page.body);
        const reply = await read(`${search}?awbNumber=${number}&forCarrier=LO-V2`, {
          Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': apiKey,
          Authorization: `Bearer ${token}`, Origin: tracker.slice(0, -1), Referer: tracker,
        }, [401, 403, 404]);
        if (reply.status === 401 || reply.status === 403) {
          if (verification.test(reply.body)) throw new ChallengeError(provider, 'LOT Cargo returned a verification page');
          throw new SchemaError(provider, 'LOT Cargo refused the tracker’s key or token');
        }
        let data: unknown;
        try {
          data = JSON.parse(reply.body);
        } catch (cause) {
          if (verification.test(reply.body)) throw new ChallengeError(provider, 'LOT Cargo returned a verification page');
          throw new SchemaError(provider, 'LOT Cargo returned unreadable tracking JSON', { cause });
        }
        return parseLotCargoTracking(data, number);
      },
    }]);
  },
});
