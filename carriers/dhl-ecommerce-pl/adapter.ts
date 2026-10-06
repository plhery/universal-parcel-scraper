import { createHash } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, IndeterminateError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeDhlEcommercePlNumber, parseDhlEcommercePl, parseDhlEcommercePlChallenge, parseDhlEcommercePlRejection,
  type DhlEcommercePlChallenge } from './parser.js';

const PROVIDER = 'DHL eCommerce Poland';
// The guest routes behind mojdhl.pl. They return the current status and none
// of the recipient's details.
const BASE = 'https://mojdhl.pl/api/dhl/public';

/**
 * The proof of work the page computes for every visitor before a lookup: the
 * number whose SHA-256 with the salt is the challenge, sent back with the
 * signed challenge.
 */
export async function solveDhlEcommercePlChallenge(task: DhlEcommercePlChallenge, signal: AbortSignal, deadline: number, budgetMs: number): Promise<string> {
  for (let number = 0; number <= task.maxnumber; number += 1) {
    if (createHash('sha256').update(task.salt + number).digest('hex') === task.challenge) {
      return Buffer.from(JSON.stringify({ algorithm: task.algorithm, challenge: task.challenge, number, salt: task.salt, signature: task.signature })).toString('base64');
    }
    if (number % 2048 === 2047) {
      // Let cancellation and deadline timers run during the search.
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new BudgetExceededError(PROVIDER, budgetMs);
    }
  }
  throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland sent a request challenge without a solution');
}

export class DhlEcommercePlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDhlEcommercePlNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    return runSteps({ carrier: 'dhl-ecommerce-pl', budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      // One deadline covers the challenge, its solution and the lookup.
      const deadline = performance.now() + remainingMs;
      const left = () => {
        const ms = Math.floor(deadline - performance.now());
        if (ms <= 0) throw new BudgetExceededError(PROVIDER, budgetMs);
        return ms;
      };
      // A page in place of JSON is a block, whatever its status says.
      const json = (bytes: Uint8Array): unknown => {
        try { return parseJsonBytes(bytes, PROVIDER); }
        catch (cause) { throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland returned a page instead of tracking JSON', { cause }); }
      };
      const headers = { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent) };
      const issued = await fetchBounded(`${BASE}/auth/captcha/challenge`, { signal, headers }, {
        provider: PROVIDER, timeoutMs: left(), maxBytes: 20_000, fetcher: this.options.fetcher,
      });
      const proof = await solveDhlEcommercePlChallenge(parseDhlEcommercePlChallenge(json(issued.bytes)), signal, deadline, budgetMs);
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(`${BASE}/shipment/status`, { method: 'POST', signal,
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ number1: number, 'captcha-payload': proof }) }, {
        provider: PROVIDER, timeoutMs: left(), maxBytes: 500_000, allowHttpStatuses: [400, 422], fetcher: this.options.fetcher,
      });
      if (response.status === 422) return parseDhlEcommercePlRejection(json(bytes));
      // A 400 is the portal refusing the proof: nothing was looked up.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland returned an inconclusive tracking response');
      return parseDhlEcommercePl(json(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DhlEcommercePlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dhl-ecommerce-pl', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDhlEcommercePlNumber(number))) };
};
