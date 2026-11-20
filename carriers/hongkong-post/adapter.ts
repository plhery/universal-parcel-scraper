import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { BudgetExceededError } from '../../core/errors/index.js';
import { recoverableByDefault, runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { userAgentOf } from '../../core/transport/index.js';
import { askMailTracing } from './chatbot.js';
import { HongkongPostOcr } from './ocr.js';
import { normalizeHongkongPostNumber, parseHongkongPostAnswer } from './parser.js';
import { trackOnWebsite } from './website.js';

/**
 * The tracker's verification usually passes within ten seconds, and the
 * chatbot's ten short requests take a few more; an idle chatbot poll alone holds 30 s.
 */
const DEFAULT_BUDGET_MS = 45_000;
/** Below this the tracker's verification has no time to pass, and the chatbot answers alone. */
const WEBSITE_MIN_BUDGET_MS = 15_000;
type Solver = (bytes: Uint8Array, signal: AbortSignal) => Promise<string>;

export class HongkongPostTracker {
  private readonly ocr = new HongkongPostOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHongkongPostNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    // The chatbot keeps time to answer when the tracker refuses every answer.
    const chatbotReserveMs = Math.min(15_000, Math.floor(budgetMs / 3));
    return runSteps({ carrier: 'hongkong-post', budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'website', enabled: budgetMs >= WEBSITE_MIN_BUDGET_MS,
      run: ({ signal, remainingMs }) => trackOnWebsite(number, { fetcher: this.options.fetcher, userAgent, signal, budgetMs,
        deadline: performance.now() + remainingMs - chatbotReserveMs, solve: this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr) }),
    }, { id: 'direct',
      // The tracker's share of the budget running out leaves the chatbot its reserve.
      recovers: error => recoverableByDefault(error) || error instanceof BudgetExceededError,
      run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const answer = await askMailTracing(number, { fetcher: this.options.fetcher, userAgent, signal, deadline, budgetMs,
        // The step's signal ends at the budget too, and its timer can fire just before the deadline reads as passed.
        spent: () => performance.now() >= deadline || (signal.aborted && !context.signal?.aborted) });
      return parseHongkongPostAnswer(answer);
    } }]);
  }

  close() { return this.ocr.close(); }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HongkongPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'hongkong-post', recordsSteps: true, steps: ['website', 'direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
