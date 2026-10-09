import { AsyncLocalStorage } from 'node:async_hooks';
import { AdapterRegistry, type AdapterEnvironment, type TrackingContext } from '../core/adapter/index.js';
import { carrierDefinition, carrierTimezone } from '../core/catalog/index.js';
import { normalizeCarrierInputs } from '../core/catalog/inputs.js';
import { deliveryHandoff, type DeliveryHandoff } from '../core/catalog/handoff.js';
import { detectCarrierMatch, isValidS10TrackingNumber, normalizeTrackingNumber, parseTrackingInput, validTrackingNumber } from '../core/detection/index.js';
import { BudgetExceededError, IndeterminateError, InputRequiredError, type CarrierErrorKind } from '../core/errors/index.js';
import { failureHint, failureKind, type FailureHint } from '../core/errors/hint.js';
import { recognitionCandidates, recognizeAll, settleRecognition } from '../core/recognition/index.js';
import { deliveredToDoor } from '../core/result/pickup.js';
import { resolveResult, resultHasUpdate, type ResolvedEvent, type ResolvedResult } from '../core/result/resolve.js';
import { runSteps } from '../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../core/telemetry/index.js';
import { EXPLICIT_OFFSET_PATTERN, explicitOffsetTime } from '../core/time/index.js';
import { eventTimestamp } from '../core/time/result.js';
import { TrawlClient } from '../core/transport/trawl.js';
import { userAgentOf } from '../core/transport/userAgent.js';
import type { Stage } from '../generated/catalog.js';
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
  /** How this install names itself to carriers that accept a plain client. */
  userAgent?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** A registry built by the host carries its own environment, `userAgent` included. */
  registry?: AdapterRegistry;
  /** Minimum gap between calls to the same universal provider in this process. */
  providerSpacingMs?: number;
}

export interface ParcelInput {
  number: string;
  carrier?: string;
  postcode?: string | null;
  /** @deprecated Accepted for compatibility; it no longer affects a lookup. */
  countryHint?: string | null;
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
  /** The carrier's own partial answer as it came, when a provider's fuller history became `result`. */
  direct?: ResolvedResult;
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

/**
 * Added to the budget an attempt is given, so that at the caller's deadline it
 * is this lookup's signal that ends the attempt, not the source's own timer a
 * moment earlier: the attempt is then a spent budget, not a failed source.
 */
const DEADLINE_SLACK_MS = 25;

/**
 * How far along a parcel is, for comparing two answers about it. Stages a parcel
 * moves between in either order share a rank; `exception` has none.
 */
const PROGRESS: Partial<Record<Stage, number>> = {
  pending: 0, registered: 1, accepted: 2, in_transit: 3, customs: 3,
  out_for_delivery: 4, failed_attempt: 4, ready_for_pickup: 4, delivered: 5, returned: 5,
};
const FINAL_STAGES = new Set(['delivered', 'returned']);

/** A provider relaying the carrier's newest scan can drop its seconds. */
const SAME_SCAN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The span of instants a clock can name: one with an offset, else its wall time in any zone, UTC−12 to UTC+14. */
interface ClockSpan { earliest: number; latest: number }

function clockSpan(value: unknown): ClockSpan | null {
  if (typeof value !== 'string') return null;
  const exact = explicitOffsetTime(value);
  if (exact) return { earliest: exact.timestamp, latest: exact.timestamp };
  // A wall clock needs a whole calendar date: a time alone would read as today, a month as its first day.
  if (EXPLICIT_OFFSET_PATTERN.test(value.trim()) || !/^\s*(?:\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{4})/.test(value)) return null;
  const wall = Date.parse(eventTimestamp(value, 'UTC') ?? '');
  if (!Number.isFinite(wall)) return null;
  // A date alone can be any time of that day.
  return { earliest: wall - 14 * HOUR_MS, latest: wall + (/\d:\d\d/.test(value) ? 12 : 36) * HOUR_MS };
}

/** Where a result's newest clock can fall, from every clock it states, or null without one. */
function newestSpan(result: ResolvedResult): ClockSpan | null {
  const spans = [result.last_update, result.last_update_local, ...result.events.flatMap(event => [event.time, event.local_time])]
    .map(clockSpan).filter((span): span is ClockSpan => span !== null);
  return spans.length ? { earliest: Math.max(...spans.map(span => span.earliest)), latest: Math.max(...spans.map(span => span.latest)) } : null;
}

/** Where an event's own clock can fall, or null without one. */
const eventSpan = (event: ResolvedEvent): ClockSpan | null => clockSpan(event.time) ?? clockSpan(event.local_time);

/**
 * How many scans a history holds. A provider can relay one scan twice in two wordings, so events
 * at the same minute and stage count once; an event without a time of day counts on its own.
 */
function scanCount(result: ResolvedResult): number {
  return new Set(result.events.map((event, index) => {
    const clock = [event.time, event.local_time]
      .find((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value));
    return clock ? `${clock.slice(0, 16).replace(' ', 'T')}|${event.stage}` : index;
  })).size;
}

/**
 * Whether a history holds the carrier's final stage no earlier than the carrier, with only scans
 * of an earlier rank after it: its newest event at that stage is not behind the carrier's own, or
 * behind the carrier's state for a summary.
 */
function reached(answer: ResolvedResult, direct: ResolvedResult, stage: string): boolean {
  const index = answer.events.findIndex(event => event.stage === stage);
  if (index < 0) return false;
  // A scan uploaded late, such as processing, may follow it; a delivery, a return or an exception may not.
  const rank = PROGRESS[stage as Stage] ?? 0;
  if (answer.events.slice(0, index).some(event => (PROGRESS[event.stage] ?? rank) >= rank)) return false;
  const theirs = answer.events[index]!;
  const own = direct.events.find(event => event.stage === stage);
  const ours = own ? eventSpan(own) : newestSpan(direct);
  const their = eventSpan(theirs);
  return !(ours && their && their.latest + SAME_SCAN_MS < ours.earliest);
}

/**
 * Whether a provider's answer should replace a partial direct one. It must hold more scans, name
 * no other carrier than `carriers` (any carrier when null), and not be behind the carrier's own
 * state. Clocks rule a provider out when even its latest reading is before the carrier's earliest
 * one. A final direct stage needs the same stage, or a history that reached it too with only
 * scans of an earlier rank after it, such as a scan uploaded after the delivery; otherwise an
 * earlier stage never replaces it. A different stage of the same rank, or an exception against
 * another stage, needs a newest scan that is certainly later. Two exceptions can be two problems,
 * so the provider's must be certainly no earlier, as when it relays the carrier's own.
 */
function fuller(answer: ResolvedResult, direct: ResolvedResult, carriers: readonly string[] | null): boolean {
  if (scanCount(answer) <= scanCount(direct)) return false;
  if (carriers && typeof answer.discovered_carrier === 'string' && !carriers.includes(answer.discovered_carrier)) return false;
  const ours = newestSpan(direct);
  const theirs = newestSpan(answer);
  if (ours && theirs && theirs.latest + SAME_SCAN_MS < ours.earliest) return false;
  const was = direct.current_stage;
  const now = answer.current_stage;
  if (was === undefined || (now === was && now !== 'exception')) return true;
  const from = PROGRESS[was as Stage];
  const to = PROGRESS[now as Stage];
  if (FINAL_STAGES.has(was)) return from !== undefined && to !== undefined && to < from && reached(answer, direct, was);
  if (from !== undefined && to !== undefined && from !== to) return to > from;
  if (now === was) return Boolean(ours && theirs && theirs.earliest + SAME_SCAN_MS >= ours.latest);
  return Boolean(ours && theirs && theirs.earliest > ours.latest + SAME_SCAN_MS);
}

/** What the carrier states about the parcel beside its scans, recipient details aside; each group is kept whole. */
const CARRIER_FACTS = [
  ['expected_delivery', 'expected_delivery_from'], ['delivery_carrier', 'delivery_tracking_number'],
  ['destination_country', 'destination_country_name'], ['canonical_tracking_number'], ['international_tracking_number'],
  ['sender_name'], ['pickup_point'], ['delivered_at'], ['weight_kg'], ['dimensions_text'], ['service_name'],
] as const;

/** The carrier's current status, which a final stage keeps over a history that scanned on after reaching it. */
const CARRIER_STATE = ['status', 'current_stage', 'current_stage_source', 'last_status_text'] as const;

/**
 * A provider's history with the carrier's own facts it lacks. An estimate does not outlive a final
 * stage, and a pickup point does not outlive a door delivery the history shows.
 */
function withCarrierFacts(answer: ResolvedResult, direct: ResolvedResult): ResolvedResult {
  const merged: ResolvedResult = { ...answer };
  if (FINAL_STAGES.has(direct.current_stage ?? '') && answer.current_stage !== direct.current_stage) {
    for (const field of CARRIER_STATE) {
      if (direct[field] === undefined) delete merged[field];
      else Object.assign(merged, { [field]: direct[field] });
    }
  }
  for (const group of CARRIER_FACTS) {
    if (group[0] === 'expected_delivery' && FINAL_STAGES.has(merged.current_stage ?? '')) continue;
    if (group[0] === 'pickup_point' && deliveredToDoor(merged)) continue;
    if (group.every(field => answer[field] == null) && group.some(field => direct[field] != null)) {
      for (const field of group) if (direct[field] != null) Object.assign(merged, { [field]: direct[field] });
    }
  }
  return merged;
}

/** The most the providers keep back for the partner a partial carrier answer names; a third of a shorter lookup. */
const HANDOFF_RESERVE_MS = 30_000;

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
    userAgent: userAgentOf(options.userAgent),
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
    // The budget cancels what is still in flight and ends the wait: carriers that have not
    // answered by then are reported as unanswered. Only the caller's own signal rejects.
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    const candidates = recognitionCandidates(number).filter(candidate => typeof registry.for(candidate.carrier)?.recognize === 'function');
    const ask = () => lookupSignals.run(signal, () => recognizeAll(candidates, carrier =>
      registry.for(carrier)!.recognize!(number, { signal, budgetMs: ms }), ms));
    const outcomes = await (context.signal ? bounded(ask, context.signal) : ask());
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
    if (!input.carrier && recognitionCandidates(number).length > 0) {
      try {
        const answer = await recognize(number, { signal, budgetMs: Math.min(10_000, ms) });
        if (answer.carrier) carrier = answer.carrier;
        else if (answer.choices.length) throw new InputRequiredError('Tracking', 'carrier', 'Choose a carrier for this number');
      } catch (error) {
        if (context.signal?.aborted) throw context.signal.reason;
        if (error instanceof InputRequiredError) throw error;
        // Recognition used the whole budget: no source was asked, and that is the failure to report.
        if (signal.aborted) throw new TrackingError([], failureHint(new BudgetExceededError('Tracking', ms)));
      }
    }
    if (input.countryHint != null && typeof input.countryHint !== 'string') throw new TypeError('Invalid country hint');
    if (input.postcode != null && typeof input.postcode !== 'string') throw new TypeError('Invalid postcode');
    if (input.trackingUrl != null && typeof input.trackingUrl !== 'string') throw new TypeError('Invalid tracking URL');
    const fields = normalizeCarrierInputs(carrier, number, input.trackingUrl ?? '', input.postcode ?? '');
    const attempts: TrackingAttempt[] = [];
    let lastError: unknown = new IndeterminateError('Tracking', 'No configured source accepts this parcel');
    const remaining = () => Math.max(1, end - Date.now());
    /** One source's answer, or null. `cut` can end it before the lookup does; either ending is a spent budget. */
    async function attempt(source: string, run: () => Promise<unknown>, cut: AbortSignal = signal): Promise<ResolvedResult | null> {
      const start = performance.now();
      try {
        const result = resolveResult(await bounded(() => lookupSignals.run(cut, run), cut));
        if (result.events.length === 0 && !resultHasUpdate(result)) throw new IndeterminateError(source, 'No tracking history is available');
        attempts.push({ source, kind: 'ok', durationMs: Math.round(performance.now() - start) });
        return result;
      } catch (error) {
        // A source that cannot take this number says nothing about the failure an earlier source reported.
        if (!attempts.some(entry => entry.kind !== 'ok') || failureKind(error) !== 'invalid_input') lastError = error;
        attempts.push({ source, kind: cut.aborted ? 'budget' : failureKind(error), durationMs: Math.round(performance.now() - start) });
        if (context.signal?.aborted) throw context.signal.reason;
        return null;
      }
    }
    const adapter = registry.for(carrier);
    const directInput = { number, postcode: fields.postcode, trackingUrl: fields.trackingUrl };
    const directBudget = () => Math.min(remaining() + DEADLINE_SLACK_MS, 60_000);
    let result = adapter ? await attempt(carrier, () => adapter.recordsSteps || adapter.steps.length > 1
      ? adapter.track(directInput, { signal, budgetMs: directBudget() })
      : runSteps({ carrier, budgetMs: directBudget(), signal, recorder: environment.recorder }, [
        { id: adapter.steps[0] ?? 'direct', run: ({ signal: stepSignal, remainingMs }) => adapter.track(
          directInput, { signal: stepSignal, budgetMs: remainingMs }) },
      ])) : null;
    let source: string = carrier;
    // A partial direct answer stands unless an enabled provider holds a fuller history that is not behind it.
    const partial = result && (result.summary_only === true || result.history_truncated === true) ? result : null;
    // The carrier's own evidence of a partner comes first, and the providers leave its lookup time to run.
    const named = partial && deliveryHandoff(carrier, number, partial);
    const reserve = named && registry.has(named.carrier) ? Math.min(HANDOFF_RESERVE_MS, Math.floor(ms / 3)) : 0;
    let relayed: ResolvedResult | null = null;
    if (!result || partial) {
      const plan = universalPlan({ carriers: [carrier], trackingNumber: number, enablePostalNinja: enabled.includes('Postal Ninja') });
      const zone = carrierTimezone(carrier) === 'UTC' ? null : carrierTimezone(carrier);
      // A checksum-valid S10 number is one postal item for every operator that carries it, so a
      // provider naming only the destination post or a consolidator still describes this parcel.
      const owners = isValidS10TrackingNumber(number) ? null
        : [carrier, partial?.delivery_carrier, named?.carrier].filter((id): id is string => typeof id === 'string');
      for (const candidate of plan.sources.filter(source => enabled.includes(source))) {
        const left = remaining();
        if (signal.aborted || left <= reserve) break;
        const share = left - reserve;
        const cut = reserve ? AbortSignal.any([signal, AbortSignal.timeout(share)]) : signal;
        const answer = await attempt(candidate, () => provider(candidate, async () => resolveResult(await universal.fetchSource(candidate,
          number, Math.min(share + DEADLINE_SLACK_MS, universalSourceBudget(candidate)), fields.postcode, zone, cut, input.countryHint)), cut), cut);
        if (answer && (!partial || fuller(answer, partial, owners))) {
          relayed = answer;
          result = partial ? withCarrierFacts(answer, partial) : answer;
          source = candidate;
          break;
        }
      }
    }
    if (!result) throw new TrackingError(attempts, signal.aborted
      ? failureHint(new BudgetExceededError('Tracking', ms)) : failureHint(lastError));
    const direct = partial && relayed ? partial : null;
    const response: TrackingResponse = { carrier, source, result, attempts, ...(direct ? { direct } : {}) };
    const proposal = named || deliveryHandoff(carrier, number, relayed ?? result);
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
