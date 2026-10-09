import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { readAnPostApp } from './app.js';
import { AN_POST, normalizeAnPostNumber } from './parser.js';

export class AnPostTracker {
  constructor(private readonly options: {
    fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder;
    /** Guest API key. Omit for the included key; null or blank disables the lookup. */
    key?: string | null;
  } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAnPostNumber(raw);
    const budgetMs = context.budgetMs ?? 20_000;
    if (!Number.isFinite(budgetMs)) throw new TypeError('An Post budget must be a finite number of milliseconds');
    const key = this.options.key;
    // AN_POST_TRACKING_KEY set empty turns the only step off.
    if (key !== undefined && !key?.trim()) throw new ChallengeError(AN_POST, 'An Post tracking API key is disabled');
    return runSteps({ carrier: 'an-post', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{
      id: 'direct', run: ({ signal, remainingMs }) => readAnPostApp(number, {
        key, fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal, timeoutMs: remainingMs,
      }),
    }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AnPostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder,
    key: environment.env.AN_POST_TRACKING_KEY });
  return { id: 'an-post', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
