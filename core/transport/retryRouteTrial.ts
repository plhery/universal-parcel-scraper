/**
 * A bounded comparison of two proxy routes for a browser retry that already
 * exists. Outcomes are saved as evidence and never steer the assignment.
 *
 * The residential route is paid by the byte, so its budget is held in two
 * places. The host's store grants every residential attempt a reservation,
 * atomically and durably, before the attempt may start: the worker allowance
 * plus a margin, counted against the cap until the attempt's verified proof
 * lowers it. The worker then carries at most that allowance for the attempt
 * and no tunnel outside a lookup. Every attempt of a trial gets the same
 * allowance, so both routes run under the same rules.
 */
export type TrialRoute = 'datacenter' | 'residential';

export type TrialEnd = 'samples' | 'bytes' | 'deadline';

/** One assigned attempt, without parcel, address or proxy details. */
export interface RetryRouteAttempt {
  /** Random identifier; the worker's lease and the store's row both carry it. */
  id: string;
  trial: string;
  route: TrialRoute;
  /** Epoch milliseconds when the attempt began. */
  assignedAt: number;
  /** Epoch milliseconds when the attempt ended, absent while it runs or when its process stopped first. */
  settledAt?: number;
  /**
   * The step outcome, such as `ok`, `challenge` or `transport`; `byte_allowance` when the worker
   * cut a failed attempt at its allowance, `not_started` for a reservation whose answer came too late to use.
   */
  outcome?: string;
  /** Whether a successful attempt returned dated history. */
  history?: boolean;
  /** Tunnel bytes the worker reported for the attempt. */
  bytes?: number;
  /** Residential only: the bytes the store reserved before the attempt began, its allowance plus the margin. */
  reservedBytes?: number;
  /** Residential only: what the attempt counts against the cap, the reservation until a verified proof replaces it. */
  chargedBytes?: number;
}

/** What a store holds for a trial. */
export interface RetryRouteTrialState {
  /** Every attempt saved for the trial, in any order. */
  attempts: readonly RetryRouteAttempt[];
  /** When the store dated the trial's start, once it has. */
  startedAt?: number;
  /** Once set, the trial stays ended. */
  end?: { reason: TrialEnd; at: number };
}

export interface RetryRouteReservationRequest {
  /** A residential attempt whose `reservedBytes` and `chargedBytes` are its reservation. */
  attempt: RetryRouteAttempt;
  targetAttempts: number;
  maxResidentialBytes: number;
  durationMs: number;
  /** How long an unsettled reservation keeps the route for itself. */
  leaseMs: number;
}

export type RetryRouteReservation =
  | { granted: true; startedAt: number }
  /** Another residential attempt is still running; this one takes the datacenter route. */
  | { granted: false; busy: true }
  | { granted: false; end: { reason: TrialEnd; at: number } };

/**
 * Where a long-lived host keeps a trial. `reserve` is the only way a residential
 * attempt is created, and it must be atomic for every process that shares the
 * store: it ends the trial, for good, once the trial is past its deadline, has
 * `targetAttempts` residential attempts (`not_started` ones aside) or the
 * charges saved so far plus the new reservation exceed the cap with none still
 * running; refuses while another reservation is unsettled and younger than
 * `leaseMs`; and otherwise saves the attempt before it resolves. The trial
 * dates its start from its first saved attempt.
 */
export interface RetryRouteTrialStore {
  load(trial: string): Promise<RetryRouteTrialState>;
  /** Saves a datacenter attempt, or a residential attempt's settlement; never creates a residential attempt. */
  save(attempt: RetryRouteAttempt): Promise<void>;
  reserve(request: RetryRouteReservationRequest): Promise<RetryRouteReservation>;
  /** Records the end a process found from the attempts, unless the trial already has one. */
  end(trial: string, end: { reason: TrialEnd; at: number }): Promise<void>;
}

export interface RetryRouteTrialOptions {
  /** Names the trial in the store; another name starts a new trial. */
  id: string;
  store: RetryRouteTrialStore;
  /** Attempts per route; the residential route stops at it. */
  targetAttempts: number;
  /** Residential bytes the trial may charge in all. */
  maxResidentialBytes: number;
  /** Time from the first assignment after which the residential route gets no further attempt. */
  durationMs: number;
  /** Tunnel bytes the worker may carry for one trial attempt before it cuts every tunnel. */
  allowanceBytes: number;
  /**
   * Bytes charged on top of what a proof shows, for data in flight when the worker closes
   * the tunnels and for the gateway's own exchanges; a reservation is the allowance plus this.
   */
  marginBytes: number;
  /** How long an unsettled residential reservation keeps the route; later it counts as lost. */
  leaseMs?: number;
  now?: () => number;
  random?: () => number;
  /** How long a failed store call keeps the residential route closed. */
  reloadMs?: number;
  /** How long an assignment waits for the store before taking the datacenter route. */
  storeTimeoutMs?: number;
}

export interface RouteTally {
  attempts: number;
  settled: number;
  /** Successful attempts with dated history. */
  history: number;
  /** Settled attempts by step outcome. */
  outcomes: Record<string, number>;
  /** Tunnel bytes the workers reported. */
  bytes: number;
  /** Attempts without a byte report: lost replies, failures before the worker answered, or still running. */
  unmeasured: number;
}

export interface RetryRouteTrialSnapshot {
  trial: string;
  /** `loading` until the store answered; `unavailable` while a failed store call keeps residential closed; `active` while both routes are assigned. */
  phase: 'loading' | 'unavailable' | 'active' | 'complete';
  startedAt: number | null;
  deadlineAt: number | null;
  endedAt: number | null;
  endReason: TrialEnd | null;
  /** Residential bytes counted against the cap: verified proofs plus margin, and the whole reservation otherwise. */
  chargedResidentialBytes: number;
  /** Of those, the reservations of attempts still running. */
  reservedResidentialBytes: number;
  maxResidentialBytes: number;
  allowanceBytes: number;
  marginBytes: number;
  targetAttempts: number;
  /** Attempts assigned while the trial was active. */
  routes: Record<TrialRoute, RouteTally>;
  /** Attempts assigned after it ended, all on the datacenter route, counted in this process only. */
  after: RouteTally;
}

/** The worker's lease for one attempt: its id and the bytes it may carry. */
export interface RetryRouteLease {
  id: string;
  allowanceBytes: number;
}

export interface RetryRouteSettlement {
  outcome: string;
  history: boolean;
  /** Tunnel bytes the worker reported. */
  bytes?: number;
  /** The worker's proof named this lease and its allowance, so it enforced them. */
  verified?: boolean;
  /** The worker cut the attempt at its allowance. */
  limited?: boolean;
}

export interface RetryRouteAssignment {
  route: TrialRoute;
  /** For a trial attempt; null after the trial, when the worker applies its own allowance. */
  lease: RetryRouteLease | null;
  settle: (result: RetryRouteSettlement) => void;
}

/** Biased coin: the route behind gets two chances in three, so assignment stays balanced and unpredictable. */
const LAGGING_ROUTE_CHANCE = 2 / 3;
/** An outcome that marks a reservation never used: no sample and no charge. */
const NOT_STARTED = 'not_started';

function tally(): RouteTally { return { attempts: 0, settled: 0, history: 0, outcomes: {}, bytes: 0, unmeasured: 0 }; }

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Retry route trial ${name} must be a positive whole number`);
  return value;
}

function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
  })]).finally(() => clearTimeout(timer));
}

const validEnd = (end: unknown): end is { reason: TrialEnd; at: number } => typeof end === 'object' && end !== null
  && ['samples', 'bytes', 'deadline'].includes((end as { reason?: unknown }).reason as string)
  && Number.isFinite((end as { at?: unknown }).at);

type Tracked = RetryRouteAttempt & { inTrial: boolean };

export class RetryRouteTrial {
  readonly #options: Required<Omit<RetryRouteTrialOptions, 'store'>> & { store: RetryRouteTrialStore };
  readonly #attempts = new Map<string, Tracked>();
  #loaded = false;
  #loading: Promise<void> | null = null;
  #retryAt = 0;
  #storeFailing = false;
  #startedAt: number | null = null;
  #endedAt: number | null = null;
  #endReason: TrialEnd | null = null;
  #writes: Promise<void> = Promise.resolve();
  readonly #after = tally();

  constructor(options: RetryRouteTrialOptions) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(options.id)) throw new TypeError('Retry route trial id must be a short plain token');
    positive('target', options.targetAttempts); positive('byte cap', options.maxResidentialBytes);
    positive('duration', options.durationMs); positive('allowance', options.allowanceBytes);
    if (!Number.isSafeInteger(options.marginBytes) || options.marginBytes < 0) throw new TypeError('Retry route trial margin must not be negative');
    if (options.allowanceBytes + options.marginBytes > options.maxResidentialBytes) {
      throw new TypeError('Retry route trial reservation must fit within its byte cap');
    }
    this.#options = { now: Date.now, random: Math.random, reloadMs: 60_000, storeTimeoutMs: 3_000, leaseMs: 180_000, ...options };
  }

  get #reservation(): number { return this.#options.allowanceBytes + this.#options.marginBytes; }

  /** Loads the trial once; a failure is retried at a later assignment after `reloadMs`. */
  load(waitMs = this.#options.storeTimeoutMs): Promise<void> {
    if (this.#loaded) return Promise.resolve();
    if (this.#loading) return bounded(this.#loading, waitMs, 'Retry route trial store did not answer').catch(() => {});
    if (this.#options.now() < this.#retryAt) return Promise.resolve();
    const loading = (async () => {
      try {
        const state = await bounded(this.#options.store.load(this.#options.id), this.#options.storeTimeoutMs, 'Retry route trial store did not answer');
        for (const attempt of state.attempts) {
          if (attempt.trial !== this.#options.id || (attempt.route !== 'datacenter' && attempt.route !== 'residential')
            || !Number.isFinite(attempt.assignedAt)) continue;
          if (!this.#attempts.has(attempt.id)) this.#attempts.set(attempt.id, { ...attempt, inTrial: true });
        }
        if (Number.isFinite(state.startedAt)) this.#noteStart(state.startedAt!);
        if (validEnd(state.end)) this.#end(state.end.reason, state.end.at);
        this.#loaded = true; this.#storeFailing = false;
      } catch { this.#failed(); }
      finally { this.#loading = null; }
    })();
    this.#loading = loading;
    return bounded(loading, waitMs, 'Retry route trial store did not answer').catch(() => {});
  }

  /** A failed store call keeps the residential route closed for `reloadMs`, whatever later calls do. */
  #failed(): void { this.#storeFailing = true; this.#retryAt = this.#options.now() + this.#options.reloadMs; }

  #noteStart(at: number): void { if (this.#startedAt === null || at < this.#startedAt) this.#startedAt = at; }

  /** Ends the trial in this process; an end found here, not read from the store, is saved there too. */
  #end(reason: TrialEnd, at: number, fromStore = true): void {
    if (this.#endReason !== null) return;
    this.#endReason = reason; this.#endedAt = at;
    if (fromStore) return;
    const end = { reason, at };
    this.#writes = this.#writes.then(async () => {
      try { await bounded(this.#options.store.end(this.#options.id, end), this.#options.storeTimeoutMs * 4, 'Retry route trial store did not answer'); }
      catch { this.#failed(); }
    });
  }

  /**
   * The route for an eligible retry that is starting now, within `budgetMs` of
   * waiting for the store. A residential route is returned only once the store
   * has saved its reservation; anything else takes the datacenter route.
   */
  async assign({ budgetMs = Number.POSITIVE_INFINITY }: { budgetMs?: number } = {}): Promise<RetryRouteAssignment> {
    const deadline = this.#options.now() + Math.max(0, Math.min(this.#options.storeTimeoutMs, budgetMs));
    await this.load(deadline - this.#options.now());
    const now = this.#options.now();
    let active = this.#loaded && this.#active(now);
    let route: TrialRoute = 'datacenter';
    if (active && !this.#storeFailing && now >= this.#retryAt) {
      const { datacenter, residential } = this.#counts();
      const behind: TrialRoute | null = datacenter === residential ? null : datacenter < residential ? 'datacenter' : 'residential';
      const draw = this.#options.random();
      route = behind === null ? (draw < 0.5 ? 'datacenter' : 'residential')
        : draw < LAGGING_ROUTE_CHANCE ? behind : behind === 'datacenter' ? 'residential' : 'datacenter';
    }
    const attempt: Tracked = { id: crypto.randomUUID(), trial: this.#options.id, route, assignedAt: now, inTrial: active };
    if (route === 'residential') {
      const reserved = this.#reservation;
      Object.assign(attempt, { reservedBytes: reserved, chargedBytes: reserved });
      const granted = await this.#reserve(attempt, deadline - this.#options.now());
      if (granted) this.#attempts.set(attempt.id, attempt);
      else {
        // A new id: the refused one may yet be saved as an unused reservation.
        delete attempt.reservedBytes; delete attempt.chargedBytes;
        attempt.id = crypto.randomUUID();
        attempt.route = route = 'datacenter';
        active = attempt.inTrial = this.#endReason === null;
      }
    }
    if (route === 'datacenter' && active) { this.#attempts.set(attempt.id, attempt); this.#persist(attempt); }
    let settled = false;
    return {
      route,
      lease: active ? { id: attempt.id, allowanceBytes: this.#options.allowanceBytes } : null,
      settle: ({ outcome, history, bytes, verified = false, limited = false }) => {
        if (settled) return;
        settled = true;
        const reported = typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
        const label = limited && outcome !== 'ok' ? 'byte_allowance' : /^[a-z_]{1,32}$/.test(outcome) && outcome !== NOT_STARTED ? outcome : 'error';
        Object.assign(attempt, { settledAt: this.#options.now(), outcome: label, history: label === 'ok' && history,
          ...(reported === undefined ? {} : { bytes: reported }) });
        if (attempt.route === 'residential') attempt.chargedBytes = this.#charge(attempt.reservedBytes!, reported, verified, limited);
        if (attempt.inTrial) this.#persist(attempt); else this.#afterSettled(attempt);
      },
    };
  }

  /** Verified bytes plus the margin, never less than the reservation for a cut attempt, the reservation without proof. */
  #charge(reserved: number, bytes: number | undefined, verified: boolean, limited: boolean): number {
    const margin = this.#options.marginBytes;
    if (bytes === undefined) return reserved;
    if (!verified || limited) return Math.max(reserved, bytes + margin);
    return bytes + margin;
  }

  async #reserve(attempt: Tracked, waitMs: number): Promise<boolean> {
    const deadline = this.#options.now() + waitMs;
    // Earlier settlements first, so the store counts what they proved.
    await bounded(this.#writes, waitMs, 'Retry route trial store did not answer').catch(() => {});
    waitMs = deadline - this.#options.now();
    if (waitMs <= 0) return false;
    const { targetAttempts, maxResidentialBytes, durationMs, leaseMs } = this.#options;
    try {
      const result = await bounded(this.#options.store.reserve({ attempt: this.#copy(attempt), targetAttempts, maxResidentialBytes, durationMs, leaseMs }),
        waitMs, 'Retry route trial store did not answer');
      this.#storeFailing = false;
      if (result.granted) { this.#noteStart(result.startedAt); return true; }
      if ('end' in result && validEnd(result.end)) this.#end(result.end.reason, result.end.at);
      return false;
    } catch {
      this.#failed();
      // The reservation may still land; mark it unused, so it is neither a sample nor a charge.
      this.#persist({ ...attempt, settledAt: this.#options.now(), outcome: NOT_STARTED, chargedBytes: 0 });
      return false;
    }
  }

  #afterSettled(attempt: RetryRouteAttempt): void {
    const after = this.#after;
    after.attempts++; after.settled++;
    if (attempt.history) after.history++;
    if (attempt.outcome) after.outcomes[attempt.outcome] = (after.outcomes[attempt.outcome] ?? 0) + 1;
    if (attempt.bytes === undefined) after.unmeasured++; else after.bytes += attempt.bytes;
  }

  #copy(attempt: RetryRouteAttempt): RetryRouteAttempt {
    return { id: attempt.id, trial: attempt.trial, route: attempt.route, assignedAt: attempt.assignedAt,
      ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt, outcome: attempt.outcome, history: attempt.history }),
      ...(attempt.bytes === undefined ? {} : { bytes: attempt.bytes }),
      ...(attempt.reservedBytes === undefined ? {} : { reservedBytes: attempt.reservedBytes, chargedBytes: attempt.chargedBytes }) };
  }

  /** Writes in order; a failed write pauses the residential route for `reloadMs` or until a later write succeeds. */
  #persist(attempt: RetryRouteAttempt): void {
    const copy = this.#copy(attempt);
    this.#writes = this.#writes.then(async () => {
      try { await bounded(this.#options.store.save(copy), this.#options.storeTimeoutMs * 4, 'Retry route trial store did not answer'); this.#storeFailing = false; }
      catch { this.#failed(); }
    });
  }

  /** Resolves once the writes started so far have ended, for tests and orderly shutdown. */
  flush(): Promise<void> { return this.#writes; }

  #counts(): Record<TrialRoute, number> {
    const counts = { datacenter: 0, residential: 0 };
    for (const attempt of this.#attempts.values()) if (attempt.inTrial && attempt.outcome !== NOT_STARTED) counts[attempt.route]++;
    return counts;
  }

  #started(): number | null {
    let first = this.#startedAt;
    for (const attempt of this.#attempts.values()) if (attempt.inTrial && (first === null || attempt.assignedAt < first)) first = attempt.assignedAt;
    return first;
  }

  #residentialBytes(now: number): { charged: number; reserved: number } {
    let charged = 0, reserved = 0;
    for (const attempt of this.#attempts.values()) {
      if (!attempt.inTrial || attempt.route !== 'residential' || attempt.outcome === NOT_STARTED) continue;
      const reservation = attempt.reservedBytes ?? this.#reservation;
      charged += attempt.chargedBytes ?? reservation;
      if (attempt.settledAt === undefined && attempt.assignedAt > now - this.#options.leaseMs) reserved += reservation;
    }
    return { charged, reserved };
  }

  #active(now: number): boolean {
    this.#recomputeEnd(now);
    return this.#endReason === null;
  }

  /** The deadline and the sample target are found again from the attempts; the byte cap is the store's to end. */
  #recomputeEnd(now = this.#options.now()): void {
    if (this.#endReason !== null) return;
    const started = this.#started();
    if (this.#counts().residential >= this.#options.targetAttempts) {
      const last = Math.max(...[...this.#attempts.values()].filter(a => a.inTrial && a.route === 'residential').map(a => a.assignedAt));
      this.#end('samples', last, false);
    } else if (started !== null && now >= started + this.#options.durationMs) this.#end('deadline', started + this.#options.durationMs, false);
  }

  snapshot(): RetryRouteTrialSnapshot {
    const now = this.#options.now();
    if (this.#loaded) this.#recomputeEnd(now);
    const routes = { datacenter: tally(), residential: tally() };
    for (const attempt of this.#attempts.values()) {
      if (!attempt.inTrial) continue;
      const route = routes[attempt.route];
      route.attempts++;
      if (attempt.settledAt !== undefined) {
        route.settled++;
        if (attempt.history) route.history++;
        if (attempt.outcome) route.outcomes[attempt.outcome] = (route.outcomes[attempt.outcome] ?? 0) + 1;
      }
      if (attempt.bytes === undefined) route.unmeasured++; else route.bytes += attempt.bytes;
    }
    const started = this.#started();
    const { charged, reserved } = this.#residentialBytes(now);
    return {
      trial: this.#options.id,
      phase: !this.#loaded ? (this.#storeFailing ? 'unavailable' : 'loading') : this.#endReason ? 'complete'
        : this.#storeFailing || now < this.#retryAt ? 'unavailable' : 'active',
      startedAt: started,
      deadlineAt: started === null ? null : started + this.#options.durationMs,
      endedAt: this.#endedAt,
      endReason: this.#endReason,
      chargedResidentialBytes: charged,
      reservedResidentialBytes: reserved,
      maxResidentialBytes: this.#options.maxResidentialBytes,
      allowanceBytes: this.#options.allowanceBytes,
      marginBytes: this.#options.marginBytes,
      targetAttempts: this.#options.targetAttempts,
      routes,
      after: structuredClone(this.#after),
    };
  }
}

/**
 * A store for one process, holding the rules `RetryRouteTrialStore.reserve`
 * describes; a host with several processes needs the same rules in a shared,
 * transactional store.
 */
export function memoryRetryRouteTrialStore(now: () => number = Date.now): RetryRouteTrialStore & {
  rows: Map<string, RetryRouteAttempt>; trials: Map<string, { startedAt: number; end?: { reason: TrialEnd; at: number } }>;
} {
  const rows = new Map<string, RetryRouteAttempt>();
  const trials = new Map<string, { startedAt: number; end?: { reason: TrialEnd; at: number } }>();
  // Answers as a store would: later, with a throw as a rejection.
  const answer = <T>(work: () => T): Promise<T> => new Promise<T>(resolve => { resolve(work()); });
  return {
    rows, trials,
    load: trial => answer(() => {
      const state = trials.get(trial);
      return { attempts: [...rows.values()].filter(row => row.trial === trial).map(row => ({ ...row })),
        ...(state ? { startedAt: state.startedAt, ...(state.end ? { end: { ...state.end } } : {}) } : {}) };
    }),
    save: attempt => answer(() => {
      const saved = rows.get(attempt.id);
      if (attempt.route === 'residential') {
        if (saved?.route !== 'residential' || saved.trial !== attempt.trial) return;
        rows.set(attempt.id, { ...attempt, reservedBytes: saved.reservedBytes, chargedBytes: attempt.chargedBytes ?? saved.chargedBytes });
        return;
      }
      if (saved?.route === 'residential') throw new Error('An attempt keeps its route');
      rows.set(attempt.id, { ...attempt });
    }),
    end: (trial, end) => answer(() => {
      const state = trials.get(trial);
      if (!state) trials.set(trial, { startedAt: Math.min(end.at, ...[...rows.values()].filter(row => row.trial === trial).map(row => row.assignedAt)), end: { ...end } });
      else state.end ??= { ...end };
    }),
    reserve: ({ attempt, targetAttempts, maxResidentialBytes, durationMs, leaseMs }) => answer((): RetryRouteReservation => {
      const clock = Math.max(now(), attempt.assignedAt);
      const own = [...rows.values()].filter(row => row.trial === attempt.trial);
      let state = trials.get(attempt.trial);
      if (!state) trials.set(attempt.trial, state = { startedAt: Math.min(attempt.assignedAt, ...own.map(row => row.assignedAt)) });
      if (state.end) return { granted: false, end: { ...state.end } };
      const residential = own.filter(row => row.route === 'residential' && row.outcome !== NOT_STARTED);
      const charged = residential.reduce((sum, row) => sum + (row.chargedBytes ?? row.reservedBytes ?? 0), 0);
      const running = residential.some(row => row.settledAt === undefined && row.assignedAt > clock - leaseMs);
      const reason: TrialEnd | null = clock >= state.startedAt + durationMs ? 'deadline'
        : residential.length >= targetAttempts ? 'samples'
          : charged + (attempt.reservedBytes ?? 0) > maxResidentialBytes && !running ? 'bytes' : null;
      if (reason) {
        state.end = { reason, at: reason === 'deadline' ? state.startedAt + durationMs : clock };
        return { granted: false, end: { ...state.end } };
      }
      if (running || rows.has(attempt.id) || charged + (attempt.reservedBytes ?? 0) > maxResidentialBytes) return { granted: false, busy: true };
      rows.set(attempt.id, { ...attempt });
      return { granted: true, startedAt: state.startedAt };
    }),
  };
}
