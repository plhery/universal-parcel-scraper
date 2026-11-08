import { AsyncLocalStorage } from 'node:async_hooks';
import { AdapterRegistry, type AdapterEnvironment, type CarrierAdapter, type TrackingContext, type TrackingInput } from '../core/adapter/index.js';
import { runAdapter } from '../core/adapter/run.js';
import { carrierDefinition, carrierTimezone } from '../core/catalog/index.js';
import { carrierTakesPhoneDigits, carrierTakesPostcode, MissingCarrierInputError, normalizeCarrierInputs, normalizeDeliveryPostcode } from '../core/catalog/inputs.js';
import { deliveryHandoff, type DeliveryHandoff } from '../core/catalog/handoff.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput, validTrackingNumber } from '../core/detection/index.js';
import { BudgetExceededError, IndeterminateError, InputRequiredError, NoHistoryError, writtenAheadClocks, type CarrierErrorKind } from '../core/errors/index.js';
import { failureHint, type FailureHint } from '../core/errors/hint.js';
import { MAX_RECOGNITIONS, recognitionCandidates, recognizeAll, settleRecognition, type RecognitionOutcome } from '../core/recognition/index.js';
import { fillPartialAnswer, isPartialAnswer, withoutWrittenAhead } from '../core/result/partial.js';
import { resolveResult, resultHasUpdate, type ResolvedResult } from '../core/result/resolve.js';
import { NOOP_RECORDER, type StepRecorder } from '../core/telemetry/index.js';
import { TrawlClient } from '../core/transport/trawl.js';
import { sendsThrough } from '../core/transport/transportOf.js';
import { userAgentOf } from '../core/transport/userAgent.js';
import { REGISTRY } from '../generated/registry.js';
import { universalPlan, universalSourceBudget } from '../providers/plan.js';
import type { UniversalSource } from '../providers/types.js';
import { UniversalTracker } from '../providers/universal.js';
import { checkParcelFields } from './input.js';

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
  /** Where a long-lived host keeps retry route trials, as `AdapterEnvironment.retryTrialStores`. */
  retryTrialStores?: AdapterEnvironment['retryTrialStores'];
  /** A registry built by the host carries its own environment, `userAgent` included. */
  registry?: AdapterRegistry;
  /** Minimum gap between calls to the same universal provider in this process. */
  providerSpacingMs?: number;
}

export interface ParcelInput {
  number: string;
  carrier?: string;
  postcode?: string | null;
  /** The postcode's country as an ISO 3166-1 alpha-2 code, for a postcode from outside the carrier's home country. */
  postcodeCountry?: string | null;
  /** @deprecated Accepted for compatibility; it no longer affects a lookup. */
  countryHint?: string | null;
  trackingUrl?: string | null;
  /** The last digits of the recipient's or sender's phone, for a carrier whose catalog entry asks for them. */
  phoneDigits?: string | null;
  /** The reader's language as a BCP 47 tag ("fr", "de-CH"), for carriers whose tracker words its scans in it. */
  language?: string | null;
  /** Ask this enabled provider alone, whatever its coverage: no recognition, carrier lookup or hand-off. */
  source?: UniversalSource;
}

export interface TrackingAttempt {
  source: string;
  kind: CarrierErrorKind | 'ok';
  durationMs: number;
  /** The wait this source asked for after its failure, when it named one. */
  retryAfterMs?: number;
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

const sources: readonly UniversalSource[] = ['Ship24', 'ParcelsApp', '17TRACK', 'Postal Ninja', 'Track718', 'Track123', 'UPU'];

/**
 * Which failure a lookup reports when its sources fail differently, first to last: the input a
 * source asks for, a deadline that ended the lookup, a source that limited, blocked or could not
 * be reached, a reply that proves nothing, and only then a negative or a refused number.
 */
const PRECEDENCE: readonly CarrierErrorKind[] = ['input_required', 'budget', 'rate_limited', 'challenge', 'maintenance',
  'transport', 'schema', 'indeterminate', 'not_found', 'invalid_input'];

/** Failures that answer for the parcel or the input as supplied: no wait changes them. */
const ANSWERS: ReadonlySet<CarrierErrorKind> = new Set(['input_required', 'not_found', 'invalid_input']);

/**
 * The lookup's failure from each failed source's, in the order they were asked: the first of the
 * kind `PRECEDENCE` puts first, with the longest wait a source asked for while it could not answer.
 */
function lookupFailure(failures: readonly FailureHint[], spent: boolean): FailureHint {
  const reported = spent ? [...failures, { kind: 'budget' as const }] : failures;
  const chosen = reported.reduce<FailureHint | undefined>((best, next) =>
    !best || PRECEDENCE.indexOf(next.kind) < PRECEDENCE.indexOf(best.kind) ? next : best, undefined)
    ?? failureHint(new IndeterminateError('Tracking', 'No configured source accepts this parcel'));
  const waits = failures.flatMap(({ kind, retryAfterMs }) => ANSWERS.has(kind) || retryAfterMs === undefined ? [] : [retryAfterMs]);
  const { kind, field, carrier } = chosen;
  return { kind, ...(waits.length ? { retryAfterMs: Math.max(...waits) } : {}),
    ...(field === undefined ? {} : { field }), ...(carrier === undefined ? {} : { carrier }) };
}

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
  const fetcher: typeof fetch = sendsThrough((url, init) => {
    const current = lookupSignals.getStore();
    const inherited = init?.signal ?? (url instanceof Request ? url.signal : undefined);
    const signal = current && inherited ? AbortSignal.any([current, inherited]) : current ?? inherited;
    return baseFetcher(url, { ...init, ...(signal ? { signal } : {}) });
  }, options.fetcher);
  const residentialUrl = options.env?.FEDEX_RESIDENTIAL_TRAWL_URL?.trim();
  const datacenterUrl = options.env?.FEDEX_DATACENTER_TRAWL_URL?.trim();
  const environment: AdapterEnvironment = {
    fetcher,
    userAgent: userAgentOf(options.userAgent),
    trawl: options.trawlUrl ? new TrawlClient(options.trawlUrl, fetcher) : null,
    trawlRoutes: residentialUrl || datacenterUrl ? {
      ...(residentialUrl ? { 'fedex-residential': new TrawlClient(residentialUrl, fetcher) } : {}),
      ...(datacenterUrl ? { 'fedex-datacenter': new TrawlClient(datacenterUrl, fetcher) } : {}),
    } : undefined,
    browserExecutablePath: options.chromiumPath || null,
    recorder: options.recorder ?? NOOP_RECORDER,
    env: options.env ?? {},
    ...(options.retryTrialStores ? { retryTrialStores: options.retryTrialStores } : {}),
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
    const end = performance.now() + ms;
    // Candidates come from the number as printed: a rule can need its separators.
    const candidates = recognitionCandidates(raw).filter(candidate => typeof registry.for(candidate.carrier)?.recognize === 'function');
    // The carriers `recognitionAskedCarriers` names are asked first; the next MAX_RECOGNITIONS
    // only while none asked so far knows the number and the budget lasts.
    const ask = () => lookupSignals.run(signal, async () => {
      const outcomes: RecognitionOutcome[] = [];
      // A round's timer runs on the event loop's cached clock and can end it a little before
      // `end`; a lookup still in flight when a round ends shows the budget is spent.
      let inFlight = 0;
      for (let start = 0; start < candidates.length; start += MAX_RECOGNITIONS) {
        const left = Math.ceil(end - performance.now());
        const settled = settleRecognition(outcomes);
        if (start > 0 && (inFlight > 0 || left <= 0 || settled.carrier || settled.choices.length)) break;
        outcomes.push(...await recognizeAll(candidates.slice(start, start + MAX_RECOGNITIONS), async carrier => {
          inFlight += 1;
          try {
            return await registry.for(carrier)!.recognize!(number, { signal, budgetMs: left });
          } finally {
            inFlight -= 1;
          }
        }, left));
      }
      // The budget's signal only aborts once the event loop runs its timer, which can be after a
      // round's timer or a stalled loop has spent the budget. Waiting for it lets `track` see the
      // budget spent rather than ask a source with none left. That timer does not keep the
      // process alive, so a timer of the whole budget, set after it, does until it fires.
      if (!signal.aborted && (inFlight > 0 || performance.now() >= end)) {
        await new Promise<void>(resolve => {
          const alive = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => { clearTimeout(alive); resolve(); }, { once: true });
        });
      }
      return outcomes;
    });
    const outcomes = await (context.signal ? bounded(ask, context.signal) : ask());
    return { ...settleRecognition(outcomes), asked: outcomes.map(outcome => outcome.carrier),
      unanswered: outcomes.filter(outcome => outcome.status === 'failed').map(outcome => outcome.carrier) };
  }

  async function track(input: ParcelInput, context: TrackingContext = {}): Promise<TrackingResponse> {
    if (!input || typeof input.number !== 'string' || !validTrackingNumber(input.number)) throw new TypeError('Invalid tracking number');
    if (input.carrier !== undefined && (typeof input.carrier !== 'string' || !input.carrier)) throw new TypeError('Invalid carrier');
    if (input.source !== undefined && !enabled.includes(input.source)) throw new TypeError('Unknown or disabled universal provider');
    // Before recognition, so an input no lookup could take costs no carrier a request.
    checkParcelFields(input);
    const number = normalizeTrackingNumber(input.number);
    const ms = budget(context.budgetMs, 90_000);
    const end = Date.now() + ms;
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    signal.throwIfAborted();
    // Detection reads the number as printed: a dashed PostLogistics reference is its own evidence.
    let carrier = input.carrier || detectCarrierMatch(input.number).carrier;
    if (typeof carrier !== 'string') throw new TypeError('Invalid carrier');
    carrierDefinition(carrier);
    if (!input.carrier && !input.source && recognitionCandidates(input.number).length > 0) {
      try {
        const answer = await recognize(input.number, { signal, budgetMs: Math.min(10_000, ms) });
        if (answer.carrier) carrier = answer.carrier;
        else if (answer.choices.length) throw new InputRequiredError('Tracking', 'carrier', 'Choose a carrier for this number');
      } catch (error) {
        if (context.signal?.aborted) throw context.signal.reason;
        if (error instanceof InputRequiredError) throw error;
        // Recognition used the whole budget: no source was asked, and that is the failure to report.
        if (signal.aborted) throw new TrackingError([], failureHint(new BudgetExceededError('Tracking', ms)));
      }
    }
    const language = input.language ? { language: input.language } : {};
    // A provider can ask for a delivery postcode the carrier does not read; only the providers then get it.
    const postcode = input.postcode ?? '';
    const carrierPostcode = carrierTakesPostcode(carrier, number);
    // Phone digits reach only the carrier that asks for them, never a provider.
    const phoneDigits = carrierTakesPhoneDigits(carrier, number) ? input.phoneDigits ?? '' : '';
    let fields: ReturnType<typeof normalizeCarrierInputs>;
    try {
      fields = normalizeCarrierInputs(carrier, number, input.trackingUrl ?? '', carrierPostcode ? postcode : '', phoneDigits);
    } catch (error) {
      // An input the carrier's catalog entry requires is the caller's to supply, as a carrier's own gate is.
      if (error instanceof MissingCarrierInputError) {
        throw new InputRequiredError(carrier, error.field, error.message, { carrier: error.carrier, cause: error });
      }
      throw error;
    }
    const providerPostcode = carrierPostcode || !postcode.trim() ? fields.postcode : normalizeDeliveryPostcode(postcode);
    const attempts: TrackingAttempt[] = [];
    /** Each failed source's hint, in the order asked, that the lookup's failure is chosen from. */
    const failures: FailureHint[] = [];
    /** The newest source's error: the carrier's own until a provider is asked. */
    let lastError: unknown;
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
        lastError = error;
        const hint: FailureHint = cut.aborted ? { kind: 'budget' } : failureHint(error);
        // A carrier's adapter that asks for an input is the carrier asking; a provider names the carrier it relays, if any.
        const own = hint.kind === 'input_required' && hint.carrier === undefined && !sources.includes(source as UniversalSource);
        failures.push(own ? { ...hint, carrier: source } : hint);
        attempts.push({ source, kind: hint.kind, durationMs: Math.round(performance.now() - start),
          ...(hint.retryAfterMs === undefined ? {} : { retryAfterMs: hint.retryAfterMs }) });
        if (context.signal?.aborted) throw context.signal.reason;
        return null;
      }
    }
    const adapter = input.source ? undefined : registry.for(carrier);
    const postcodeCountry = fields.postcode && input.postcodeCountry ? { postcodeCountry: input.postcodeCountry.trim().toUpperCase() } : {};
    const directInput = { number, postcode: fields.postcode, ...postcodeCountry, trackingUrl: fields.trackingUrl,
      ...(fields.phoneDigits ? { phoneDigits: fields.phoneDigits } : {}), ...language };
    const directBudget = () => Math.min(remaining() + DEADLINE_SLACK_MS, 60_000);
    /** One adapter's lookup on the budget left, its answer finished as `trackCarrier` finishes it. */
    const lookUp = (id: string, registered: CarrierAdapter, lookupInput: TrackingInput, knownEstimate?: TrackingContext['knownEstimate']) => {
      const budgetMs = directBudget();
      return runAdapter(registered, { carrier: id, input: lookupInput, signal, budgetMs, runnerBudgetMs: budgetMs, knownEstimate, recorder: environment.recorder });
    };
    let result = adapter ? await attempt(carrier, () => lookUp(carrier, adapter, directInput, context.knownEstimate)) : null;
    let source: string = carrier;
    // While the issuer shows only the label, a carrier that follows the parcel under its number
    // from an earlier leg holds the history: Cainiao under GOFO's GFUS waybills. Its movement
    // files the parcel under it, and the hand-off below proposes the issuer.
    if (result && !input.carrier && !input.source && labelAlone(result)) {
      for (const origin of detectCarrierMatch(input.number).origins ?? []) {
        const followed = registry.for(origin);
        if (!followed || signal.aborted) continue;
        const answer = await attempt(origin, () => lookUp(origin, followed, { number, ...language }));
        if (answer && !labelAlone(answer)) {
          carrier = origin;
          result = answer;
          source = origin;
          break;
        }
      }
    }
    // Rows the carrier holds back as written ahead of their clocks are no scans when a provider relays them.
    const ahead = result ? [] : writtenAheadClocks(lastError);
    const scansOf = (candidate: UniversalSource, answer: ResolvedResult) => {
      const kept = withoutWrittenAhead(answer, ahead);
      if (!kept) throw new NoHistoryError(candidate, `${candidate} relays only rows the carrier wrote ahead`, { reason: 'written_ahead', writtenAhead: ahead });
      return kept;
    };
    // A partial direct answer stands unless an enabled provider holds a fuller history that is not behind it.
    const partial = result && isPartialAnswer(result) ? result : null;
    // The carrier's own evidence of a partner comes first, and the providers leave its lookup time to run.
    const named = partial && deliveryHandoff(carrier, number, partial);
    const reserve = named && registry.has(named.carrier) ? Math.min(HANDOFF_RESERVE_MS, Math.floor(ms / 3)) : 0;
    let relayed: ResolvedResult | null = null;
    if (!result || partial) {
      const plan = universalPlan({ carriers: [carrier], trackingNumber: number, enablePostalNinja: enabled.includes('Postal Ninja'), enableTrack123: enabled.includes('Track123') });
      const zone = carrierTimezone(carrier) === 'UTC' ? null : carrierTimezone(carrier);
      for (const candidate of input.source ? [input.source] : plan.sources.filter(source => enabled.includes(source))) {
        const left = remaining();
        if (signal.aborted || left <= reserve) break;
        const share = left - reserve;
        const timer = reserve ? AbortSignal.timeout(share) : null;
        const cut = timer ? AbortSignal.any([signal, timer]) : signal;
        const answer = await attempt(candidate, () => provider(candidate, async () => scansOf(candidate, resolveResult(await universal.fetchSource(candidate,
          number, Math.min(share + DEADLINE_SLACK_MS, universalSourceBudget(candidate)), providerPostcode, zone, cut, input.countryHint, carrier))), cut), cut);
        const filled = answer && partial ? fillPartialAnswer(carrier, number, partial, answer) : answer;
        if (answer && filled) {
          relayed = answer;
          result = filled;
          source = candidate;
          break;
        }
        // A provider that ran out its share leaves the partner's reserve, whatever the clock reads: a
        // timer can fire before Date.now reaches its deadline, and the sliver it leaves is no lookup.
        if (timer?.aborted) break;
      }
    }
    if (!result) throw new TrackingError(attempts, lookupFailure(failures, signal.aborted));
    const direct = partial && relayed ? partial : null;
    const response: TrackingResponse = { carrier, source, result, attempts, ...(direct ? { direct } : {}) };
    const proposal = input.source ? null : named || deliveryHandoff(carrier, number, relayed ?? result);
    if (proposal && !signal.aborted) {
      const partner = registry.for(proposal.carrier);
      if (partner) {
        // The partner's answer is finished as a direct one is. The caller's estimate is the parcel's under its own carrier, not the partner's.
        const confirmed = await attempt(proposal.carrier, () => lookUp(proposal.carrier, partner, { number: proposal.number, ...language }));
        response.handoff = { ...proposal, confirmed: Boolean(confirmed), ...(confirmed ? { result: confirmed } : {}) };
      }
    }
    return response;
  }
  return { detect, recognize, track };
}

export type Tracker = ReturnType<typeof createTracker>;

/** An answer that holds the label and nothing after it: the carrier has not scanned the parcel yet. */
function labelAlone(result: ResolvedResult): boolean {
  return result.current_stage === 'registered' && result.events.every((event) => event.stage === 'registered');
}
