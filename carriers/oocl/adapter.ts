import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchOoclInBrowser } from './browser.js';
import { ooclQuery, PROVIDER } from './parser.js';

export { decryptOoclReply, ooclLinkUrl, ooclLookups, ooclQuery, ooclResult } from './parser.js';
export type { OoclLookup, OoclQuery } from './parser.js';

const DEFAULT_BUDGET_MS = 45_000;
/** The shared local browser serves one lookup for at most a minute. */
const BROWSER_LIMIT_MS = 60_000;

export interface OoclTrackerOptions {
  /** A local Chromium; Cloudflare stops plain requests to the tracker. */
  executablePath?: string | null;
  recorder?: StepRecorder;
}

export class OoclTracker {
  readonly #executablePath: string | null;
  readonly #recorder: StepRecorder;

  constructor(options: OoclTrackerOptions = {}) {
    this.#executablePath = options.executablePath ?? null;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = ooclQuery(raw);
    const executablePath = this.#executablePath;
    if (!executablePath) throw new ChallengeError(PROVIDER, 'OOCL requires TRACKING_CHROMIUM_PATH');
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('OOCL budget must be positive');
    return runSteps<CarrierResult>({ carrier: 'oocl', budgetMs, signal: context.signal, recorder: this.#recorder }, [
      { id: 'browser', run: ({ signal, remainingMs }) => fetchOoclInBrowser(query, executablePath, signal,
        Math.min(BROWSER_LIMIT_MS, Math.max(1, Math.floor(remainingMs)))) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OoclTracker({ executablePath: environment.browserExecutablePath, recorder: environment.recorder });
  return { id: 'oocl', recordsSteps: true, steps: ['browser'], track: (input, context) => tracker.fetch(input.number, context) };
};
