import { AsyncLocalStorage } from 'node:async_hooks';
import { AdapterRegistry, type AdapterEnvironment, type TrackingContext } from '../core/adapter/index.js';
import { carrierDefinition, carrierTimezone } from '../core/catalog/index.js';
import { normalizeCarrierInputs } from '../core/catalog/inputs.js';
import { deliveryHandoff, type DeliveryHandoff } from '../core/catalog/handoff.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput, validTrackingNumber } from '../core/detection/index.js';
import { BudgetExceededError, carrierErrorKind, IndeterminateError, InputRequiredError, type CarrierErrorKind } from '../core/errors/index.js';
import { failureHint, type FailureHint } from '../core/errors/hint.js';
import { recognitionCandidates, recognizeAll, settleRecognition } from '../core/recognition/index.js';
import { resolveResult, resultHasUpdate, type ResolvedResult } from '../core/result/resolve.js';
import { runSteps } from '../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../core/telemetry/index.js';
import { TrawlClient } from '../core/transport/trawl.js';
import { REGISTRY } from '../generated/registry.js';
import { universalPlan, universalSourceBudget } from '../providers/plan.js';
import type { UniversalSource } from '../providers/types.js';
import { UniversalTracker } from '../providers/universal.js';

export interface TrackerOptions {
  trawlUrl?: string;
  chromiumPath?: string;
  /** Commercial providers are used only when included here. UPU is the default. */
  providers?: readonly UniversalSource[];
  recorder?: StepRecorder;
  fetcher?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  registry?: AdapterRegistry;
  /** Minimum gap between calls to the same universal provider in this process. */
  providerSpacingMs?: number;
}

export interface ParcelInput {
  number: string;
  carrier?: string;
  postcode?: string | null;
  trackingUrl?: string | null;
}

export interface TrackingAttempt {
  source: string;
  kind: CarrierErrorKind | 'ok';
  durationMs: number;
}

export interface TrackingResponse {
  carrier: string;
  source: string;
  result: ResolvedResult;
  attempts: TrackingAttempt[];
  /** A partner's independently bound answer; callers decide whether to adopt it. */
  handoff?: DeliveryHandoff & { confirmed: boolean; result?: ResolvedResult };
}

export class TrackingError extends Error {
  constructor(readonly attempts: readonly TrackingAttempt[], readonly hint: FailureHint) {
    super('No enabled source returned tracking history');
    this.name = 'TrackingError';
  }
}

const sources: readonly UniversalSource[] = ['Ship24', 'ParcelsApp', '17TRACK', 'Postal Ninja', 'UPU'];

function budget(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isFinite(ms) || ms < 1 || ms > 120_000) throw new TypeError('Lookup budget must be between 1 and 120000 ms');
  return Math.floor(ms);
}

async function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([run(), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function createTracker(options: TrackerOptions = {}) {
  const enabled = [...new Set(options.providers ?? ['UPU'])] as UniversalSource[];
  if (enabled.some(source => !sources.includes(source))) throw new TypeError('Unknown universal provider');
  const spacing = options.providerSpacingMs ?? 0;
  if (!Number.isFinite(spacing) || spacing < 0 || spacing > 60_000) throw new TypeError('Invalid provider spacing');
  const lookupSignals = new AsyncLocalStorage<AbortSignal>();
  const baseFetcher = options.fetcher ?? fetch;
  const fetcher: typeof fetch = (url, init) => {
    const current = lookupSignals.getStore();
    const inherited = init?.signal ?? (url instanceof Request ? url.signal : undefined);
    const signal = current && inherited ? AbortSignal.any([current, inherited]) : current ?? inherited;
    return baseFetcher(url, { ...init, ...(signal ? { signal } : {}) });
  };
  const environment: AdapterEnvironment = {
    fetcher,
    trawl: options.trawlUrl ? new TrawlClient(options.trawlUrl, fetcher) : null,
    browserExecutablePath: options.chromiumPath || null,
    recorder: options.recorder ?? NOOP_RECORDER,
    env: options.env ?? {},
  };
  const registry = options.registry ?? new AdapterRegistry(REGISTRY, environment);
  const universal = new UniversalTracker({ environment });
  const providerTails = new Map<UniversalSource, Promise<unknown>>();
  const providerLast = new Map<UniversalSource, number>();

  async function provider(source: UniversalSource, run: () => Promise<ResolvedResult>, signal: AbortSignal) {
    const previous = providerTails.get(source) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const delay = (providerLast.get(source) ?? 0) + spacing - Date.now();
      if (delay > 0) await bounded(() => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
      }), signal);
      signal.throwIfAborted();
      providerLast.set(source, Date.now());
      return await run();
    });
    providerTails.set(source, operation.catch(() => {}));
    return await bounded(() => operation, signal);
  }

  function detect(text: string) {
    if (typeof text !== 'string' || text.length > 16_384) throw new TypeError('Supply tracking text of at most 16384 characters');
    return parseTrackingInput(text);
  }

  async function recognize(raw: string, context: TrackingContext = {}) {
    if (typeof raw !== 'string' || !validTrackingNumber(raw)) throw new TypeError('Invalid tracking number');
    const number = normalizeTrackingNumber(raw);
    const ms = budget(context.budgetMs, 10_000);
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    const candidates = recognitionCandidates(number).filter(candidate => registry.for(candidate.carrier)?.recognize);
    const outcomes = await bounded(() => lookupSignals.run(signal, () => recognizeAll(candidates, carrier =>
      registry.for(carrier)!.recognize!(number, { signal, budgetMs: ms }), ms)), signal);
    return { ...settleRecognition(outcomes), asked: candidates.map(candidate => candidate.carrier),
      unanswered: outcomes.filter(outcome => outcome.status === 'failed').map(outcome => outcome.carrier) };
  }

  async function track(input: ParcelInput, context: TrackingContext = {}): Promise<TrackingResponse> {
    if (!input || typeof input.number !== 'string' || !validTrackingNumber(input.number)) throw new TypeError('Invalid tracking number');
    if (input.carrier !== undefined && (typeof input.carrier !== 'string' || !input.carrier)) throw new TypeError('Invalid carrier');
    const number = normalizeTrackingNumber(input.number);
    const ms = budget(context.budgetMs, 90_000);
    const end = Date.now() + ms;
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    signal.throwIfAborted();
    let carrier = input.carrier || detectCarrierMatch(number).carrier;
    if (typeof carrier !== 'string') throw new TypeError('Invalid carrier');
    carrierDefinition(carrier);
    if (!input.carrier && detectCarrierMatch(number).confidence !== 'high') {
      try {
        const answer = await recognize(number, { signal, budgetMs: Math.min(10_000, ms) });
        if (answer.carrier) carrier = answer.carrier;
        else if (answer.choices.length) throw new InputRequiredError('Tracking', 'carrier', 'Choose a carrier for this number');
      } catch (error) {
        if (signal.aborted || error instanceof InputRequiredError) throw error;
      }
    }
    if (input.postcode != null && typeof input.postcode !== 'string') throw new TypeError('Invalid postcode');
    if (input.trackingUrl != null && typeof input.trackingUrl !== 'string') throw new TypeError('Invalid tracking URL');
    const fields = normalizeCarrierInputs(carrier, number, input.trackingUrl ?? '', input.postcode ?? '');
    const attempts: TrackingAttempt[] = [];
    let lastError: unknown = new IndeterminateError('Tracking', 'No configured source accepts this parcel');
    const remaining = () => Math.max(1, end - Date.now());
    async function attempt(source: string, run: () => Promise<unknown>): Promise<ResolvedResult | null> {
      const start = performance.now();
      try {
        const result = resolveResult(await bounded(() => lookupSignals.run(signal, run), signal));
        if (result.events.length === 0 && !resultHasUpdate(result)) throw new IndeterminateError(source, 'No tracking history is available');
        attempts.push({ source, kind: 'ok', durationMs: Math.round(performance.now() - start) });
        return result;
      } catch (error) {
        lastError = error;
        attempts.push({ source, kind: signal.aborted ? 'budget' : carrierErrorKind(error) ?? 'transport', durationMs: Math.round(performance.now() - start) });
        if (context.signal?.aborted) throw context.signal.reason;
        return null;
      }
    }
    const adapter = registry.for(carrier);
    const directInput = { number, postcode: fields.dpdPostcode, trackingUrl: fields.trackingUrl };
    const directBudget = () => Math.min(remaining(), 60_000);
    let result = adapter ? await attempt(carrier, () => adapter.recordsSteps || adapter.steps.length > 1
      ? adapter.track(directInput, { signal, budgetMs: directBudget() })
      : runSteps({ carrier, budgetMs: directBudget(), signal, recorder: environment.recorder }, [
        { id: adapter.steps[0] ?? 'direct', run: ({ signal: stepSignal, remainingMs }) => adapter.track(
          directInput, { signal: stepSignal, budgetMs: remainingMs }) },
      ])) : null;
    let source: string = carrier;
    if (!result) {
      const plan = universalPlan({ carriers: [carrier], trackingNumber: number, enablePostalNinja: enabled.includes('Postal Ninja') });
      for (const candidate of plan.sources.filter(source => enabled.includes(source))) {
        if (signal.aborted) break;
        result = await attempt(candidate, () => provider(candidate, async () => resolveResult(await universal.fetchSource(candidate,
          number, Math.min(remaining(), universalSourceBudget(candidate)), fields.dpdPostcode,
          carrierTimezone(carrier) === 'UTC' ? null : carrierTimezone(carrier), signal)), signal));
        if (result) { source = candidate; break; }
      }
    }
    if (!result) throw new TrackingError(attempts, signal.aborted
      ? failureHint(new BudgetExceededError('Tracking', ms)) : failureHint(lastError));
    const response: TrackingResponse = { carrier, source, result, attempts };
    const proposal = deliveryHandoff(carrier, number, result);
    if (proposal && !signal.aborted) {
      const partner = registry.for(proposal.carrier);
      if (partner) {
        const confirmed = await attempt(proposal.carrier, () => partner.track({ number: proposal.number }, { signal, budgetMs: directBudget() }));
        response.handoff = { ...proposal, confirmed: Boolean(confirmed), ...(confirmed ? { result: confirmed } : {}) };
      }
    }
    return response;
  }
  return { detect, recognize, track };
}

export type Tracker = ReturnType<typeof createTracker>;
