import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { readBlazorPage } from '../../core/transport/blazorCircuit.js';
import { parseSwire, PROVIDER, SWIRE_APP, swirePageState, swirePageUrl, swireQuery } from './parser.js';

export { parseSwire, SWIRE_APP, swirePageState, swirePageUrl, swireQuery } from './parser.js';
export type { SwireQuery } from './parser.js';

/** The app's SignalR hub, which renders its pages. */
export const SWIRE_HUB = `${SWIRE_APP}_blazor`;

// The shell is under twenty kilobytes.
const SHELL_MAX_BYTES = 256 * 1024;
const DEFAULT_BUDGET_MS = 30_000;
// The page asks whether it runs on a phone, and Telerik's widgets whether the window matches
// each of their media queries; the circuit fails on an answer that is not a boolean.
const SCRIPTS = { 'layoutHelpers.isMobileView': false, 'TelerikBlazor.initMediaQuery': false };

export interface SwireShippingTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

export class SwireShippingTracker {
  constructor(private readonly options: SwireShippingTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = swireQuery(raw);
    return runSteps({ carrier: 'swire-shipping', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => readBlazorPage({
        provider: PROVIDER, name: 'Swire Shipping', app: SWIRE_APP, page: swirePageUrl(query), shellMaxBytes: SHELL_MAX_BYTES,
        componentState: true, scripts: SCRIPTS,
        fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal, deadline: performance.now() + remainingMs,
        // The page looks the number up as it opens, under a loader, and answers once the loader is gone.
        answer: ({ page, roots, started }) => {
          if (!started) return undefined;
          const html = roots.map((root) => page.html(root)).join('');
          return swirePageState(html, query) === 'pending' ? undefined : parseSwire(html, query);
        },
      }) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SwireShippingTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'swire-shipping', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
