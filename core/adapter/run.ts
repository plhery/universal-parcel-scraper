/**
 * One registered adapter's lookup, and its answer as every lookup gives it: `trackCarrier()`,
 * `createTracker()`'s direct lookup and its delivery hand-off all run an adapter through here.
 */
import { normalizeCarrierResult, type CarrierResult } from '../result/index.js';
import { dueScans } from '../result/due.js';
import { readLateRegistrations } from '../result/registration.js';
import { withoutRepeatedScans } from '../result/repeats.js';
import { readNewestStage } from '../result/unstaged.js';
import { runSteps } from '../runner/index.js';
import type { StepRecorder } from '../telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { restoreLostLetters } from '../../places/index.js';
import type { CarrierAdapter, KnownEstimate, TrackingInput } from './index.js';

export interface AdapterLookup {
  /** The carrier looked up: its clock dates local scans, and the step runner records under it. */
  carrier: string;
  input: TrackingInput;
  signal?: AbortSignal;
  /** The budget the adapter is given; without one it keeps its own. */
  budgetMs?: number;
  /** The step runner's budget, for an adapter that runs in it. */
  runnerBudgetMs: number;
  knownEstimate?: KnownEstimate;
  recorder?: StepRecorder;
}

/**
 * An adapter answer as it leaves the package: normalized, scans the carrier plans held back until
 * they are due, lost letters restored, local clocks dated, repeats read once, late registrations
 * and an unstaged newest scan read as no step back.
 */
function finishAdapterAnswer(carrier: string, result: unknown, plannedScans = false): CarrierResult {
  const answer = normalizeCarrierResult(result);
  return readNewestStage(readLateRegistrations(withoutRepeatedScans(dateLocalClocks(carrier,
    restoreLostLetters(plannedScans ? dueScans(answer, carrier) : answer), Date.now()))));
}

/**
 * Runs `adapter` for `lookup` and finishes its answer. An adapter with several steps, or one that
 * records its own, runs them itself; another runs in the step runner, which records the lookup.
 * The adapter is given a context only when the lookup has a signal, a budget or an estimate.
 * Failures, a caller's cancellation included, are left to the caller to read.
 */
export async function runAdapter(adapter: CarrierAdapter, lookup: AdapterLookup): Promise<CarrierResult> {
  const { carrier, input, signal, budgetMs } = lookup;
  const known = lookup.knownEstimate ? { knownEstimate: lookup.knownEstimate } : {};
  const passed = Boolean(signal || budgetMs !== undefined || lookup.knownEstimate);
  const result = adapter.recordsSteps || adapter.steps.length > 1
    ? await adapter.track(input, ...(passed ? [{ signal, budgetMs, ...known }] as const : []))
    : await runSteps({ carrier, budgetMs: lookup.runnerBudgetMs, signal, recorder: lookup.recorder }, [{ id: adapter.steps[0] ?? 'direct',
      run: ({ signal: step, remainingMs }) => adapter.track(input, ...(passed
        ? [{ signal: step, budgetMs: budgetMs === undefined ? undefined : Math.min(budgetMs, remainingMs), ...known }] as const : [])) }]);
  return finishAdapterAnswer(carrier, result, adapter.plannedScans);
}
