/**
 * A bounded comparison of two proxy routes for a browser retry that already
 * exists: every assigned attempt is saved through the host's store, so the
 * sample target, the byte cap on the costly route and the deadline hold across
 * restarts. Outcomes are saved as evidence and never steer the assignment.
 */
export type TrialRoute = 'datacenter' | 'residential';

/** One assigned attempt, without parcel, address or proxy details. */
export interface RetryRouteAttempt {
  /** Random identifier; the store saves an attempt again under it once it has settled. */
  id: string;
  trial: string;
  route: TrialRoute;
  /** Epoch milliseconds when the attempt began. */
  assignedAt: number;
  /** Epoch milliseconds when the attempt ended, absent while it runs or when its process stopped first. */
  settledAt?: number;
  /** The step outcome, such as `ok`, `challenge` or `transport`. */
  outcome?: string;
  /** Whether a successful attempt returned dated history. */
  history?: boolean;
  /** Tunnel bytes the worker proved for the attempt, with what it carried since its previous reply. */
  bytes?: number;
}

/** Where a long-lived host keeps the attempts. The trial assigns only the cheap route while the store fails. */
export interface RetryRouteTrialStore {
  /** Every attempt saved for the trial, in any order. */
  load(trial: string): Promise<readonly RetryRouteAttempt[]>;
  /** Saves an attempt, replacing what was saved under its id. */
  save(attempt: RetryRouteAttempt): Promise<void>;
}

export interface RetryRouteTrialOptions {
  /** Names the trial in the store; another name starts a new trial. */
  id: string;
  store: RetryRouteTrialStore;
  /** Attempts per route; the residential route stops at it. */
  targetAttempts: number;
  /** Residential bytes after which it gets no further attempt. */
  maxResidentialBytes: number;
  /** Time from the first assignment after which the residential route gets no further attempt. */
  durationMs: number;
  /** Bytes charged to a residential attempt with no byte proof, such as one lost in transport. */
  unmeasuredBytes: number;
  now?: () => number;
  random?: () => number;
  /** How long a failed load waits before the next assignment tries again. */
  reloadMs?: number;
  /** How long an assignment waits for the store's answer before taking the datacenter route. */
  loadTimeoutMs?: number;
}

export type TrialEnd = 'samples' | 'bytes' | 'deadline';

export interface RouteTally {
  attempts: number;
  settled: number;
  /** Successful attempts with dated history. */
  history: number;
  /** Settled attempts by step outcome. */
  outcomes: Record<string, number>;
  /** Proven tunnel bytes. */
  bytes: number;
  /** Attempts without byte proof: lost replies, failures before the worker answered, or still running. */
  unmeasured: number;
}

export interface RetryRouteTrialSnapshot {
  trial: string;
  /** `loading` until the store answered; `unavailable` while it fails; `active` while both routes are assigned. */
  phase: 'loading' | 'unavailable' | 'active' | 'complete';
  startedAt: number | null;
  deadlineAt: number | null;
  endedAt: number | null;
  endReason: TrialEnd | null;
  /** Residential bytes counted against the cap: proven bytes plus the charge for each unmeasured attempt. */
  chargedResidentialBytes: number;
  maxResidentialBytes: number;
  targetAttempts: number;
  /** Attempts assigned while the trial was active. */
  routes: Record<TrialRoute, RouteTally>;
  /** Attempts assigned after it ended, all on the datacenter route. */
  after: RouteTally;
}

/** Biased coin: the route behind gets two chances in three, so assignment stays balanced and unpredictable. */
const LAGGING_ROUTE_CHANCE = 2 / 3;

function tally(): RouteTally { return { attempts: 0, settled: 0, history: 0, outcomes: {}, bytes: 0, unmeasured: 0 }; }

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`Retry route trial ${name} must be positive`);
  return value;
}

export class RetryRouteTrial {
  readonly #options: Required<Omit<RetryRouteTrialOptions, 'store'>> & { store: RetryRouteTrialStore };
  readonly #attempts = new Map<string, RetryRouteAttempt & { inTrial: boolean }>();
  #loaded = false;
  #loading: Promise<void> | null = null;
  #retryAt = 0;
  #storeFailing = false;
  #endedAt: number | null = null;
  #endReason: TrialEnd | null = null;
  #writes: Promise<void> = Promise.resolve();
  /** Attempts after the trial ended: counted in this process only, as the store keeps the trial alone. */
  readonly #after = tally();

  constructor(options: RetryRouteTrialOptions) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(options.id)) throw new TypeError('Retry route trial id must be a short plain token');
    positive('target', options.targetAttempts); positive('byte cap', options.maxResidentialBytes);
    positive('duration', options.durationMs);
    if (!Number.isFinite(options.unmeasuredBytes) || options.unmeasuredBytes < 0) throw new TypeError('Retry route trial unmeasured charge must not be negative');
    this.#options = { now: Date.now, random: Math.random, reloadMs: 60_000, loadTimeoutMs: 3_000, ...options };
  }

  /** Loads the saved attempts once; a failure is retried at a later assignment. */
  load(): Promise<void> {
    if (this.#loaded) return Promise.resolve();
    if (this.#loading) return this.#loading;
    if (this.#options.now() < this.#retryAt) return Promise.resolve();
    this.#loading = (async () => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const saved = await Promise.race([this.#options.store.load(this.#options.id), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Retry route trial store did not answer')), this.#options.loadTimeoutMs);
        })]).finally(() => clearTimeout(timer));
        for (const attempt of saved) {
          if (attempt.trial !== this.#options.id || (attempt.route !== 'datacenter' && attempt.route !== 'residential')
            || !Number.isFinite(attempt.assignedAt)) continue;
          if (!this.#attempts.has(attempt.id)) this.#attempts.set(attempt.id, { ...attempt, inTrial: true });
        }
        // Attempts saved before the trial ended belong to it; the end is found again from them.
        this.#recomputeEnd();
        this.#loaded = true; this.#storeFailing = false;
      } catch {
        this.#storeFailing = true; this.#retryAt = this.#options.now() + this.#options.reloadMs;
      } finally { this.#loading = null; }
    })();
    return this.#loading;
  }

  /**
   * The route for an eligible retry that is starting now. Residential is
   * assigned only while the trial is active and its saved attempts are known;
   * otherwise the retry takes the datacenter route.
   */
  async assign(): Promise<{ route: TrialRoute; settle: (result: { outcome: string; history: boolean; bytes?: number }) => void }> {
    await this.load();
    const now = this.#options.now();
    // While a save fails, attempts still count and are saved, but only on the datacenter route,
    // whose next successful save lets residential attempts resume.
    const active = this.#loaded && this.#active(now);
    let route: TrialRoute = 'datacenter';
    if (active && !this.#storeFailing) {
      const { datacenter, residential } = this.#counts();
      const behind: TrialRoute | null = datacenter === residential ? null : datacenter < residential ? 'datacenter' : 'residential';
      const draw = this.#options.random();
      route = behind === null ? (draw < 0.5 ? 'datacenter' : 'residential')
        : draw < LAGGING_ROUTE_CHANCE ? behind : behind === 'datacenter' ? 'residential' : 'datacenter';
    }
    const attempt: RetryRouteAttempt & { inTrial: boolean } = { id: crypto.randomUUID(), trial: this.#options.id, route, assignedAt: now, inTrial: active };
    if (active) { this.#attempts.set(attempt.id, attempt); this.#persist(attempt); this.#recomputeEnd(); }
    let settled = false;
    return {
      route,
      settle: ({ outcome, history, bytes }) => {
        if (settled) return;
        settled = true;
        Object.assign(attempt, { settledAt: this.#options.now(), outcome: /^[a-z_]{1,32}$/.test(outcome) ? outcome : 'error',
          history: outcome === 'ok' && history,
          ...(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? { bytes } : {}) });
        if (attempt.inTrial) { this.#persist(attempt); this.#recomputeEnd(); } else this.#afterSettled(attempt);
      },
    };
  }

  #afterSettled(attempt: RetryRouteAttempt): void {
    const after = this.#after;
    after.attempts++; after.settled++;
    if (attempt.history) after.history++;
    if (attempt.outcome) after.outcomes[attempt.outcome] = (after.outcomes[attempt.outcome] ?? 0) + 1;
    if (attempt.bytes === undefined) after.unmeasured++; else after.bytes += attempt.bytes;
  }

  /** Writes in order; a failed write pauses the residential route until a later one succeeds. */
  #persist(attempt: RetryRouteAttempt): void {
    const copy: RetryRouteAttempt = { id: attempt.id, trial: attempt.trial, route: attempt.route, assignedAt: attempt.assignedAt,
      ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt, outcome: attempt.outcome, history: attempt.history }),
      ...(attempt.bytes === undefined ? {} : { bytes: attempt.bytes }) };
    this.#writes = this.#writes.then(async () => {
      try { await this.#options.store.save(copy); this.#storeFailing = false; }
      catch { this.#storeFailing = true; }
    });
  }

  /** Resolves once the writes started so far have ended, for tests and orderly shutdown. */
  flush(): Promise<void> { return this.#writes; }

  #counts(): Record<TrialRoute, number> {
    const counts = { datacenter: 0, residential: 0 };
    for (const attempt of this.#attempts.values()) if (attempt.inTrial) counts[attempt.route]++;
    return counts;
  }

  #startedAt(): number | null {
    let first: number | null = null;
    for (const attempt of this.#attempts.values()) if (attempt.inTrial && (first === null || attempt.assignedAt < first)) first = attempt.assignedAt;
    return first;
  }

  #charged(): number {
    let bytes = 0;
    for (const attempt of this.#attempts.values()) {
      if (!attempt.inTrial || attempt.route !== 'residential') continue;
      bytes += attempt.bytes ?? this.#options.unmeasuredBytes;
    }
    return bytes;
  }

  #active(now: number): boolean {
    this.#recomputeEnd(now);
    return this.#endReason === null;
  }

  #recomputeEnd(now = this.#options.now()): void {
    if (this.#endReason !== null) return;
    const started = this.#startedAt();
    const residential = this.#counts().residential;
    // The cap counts the next attempt's charge too, so the last one cannot carry the trial past it.
    const reason: TrialEnd | null = residential >= this.#options.targetAttempts ? 'samples'
      : this.#charged() + this.#options.unmeasuredBytes > this.#options.maxResidentialBytes ? 'bytes'
        : started !== null && now >= started + this.#options.durationMs ? 'deadline' : null;
    if (!reason) return;
    this.#endReason = reason;
    this.#endedAt = reason === 'deadline' && started !== null ? started + this.#options.durationMs
      : Math.max(...[...this.#attempts.values()].filter(a => a.inTrial).map(a => a.assignedAt), started ?? now);
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
    const started = this.#startedAt();
    return {
      trial: this.#options.id,
      phase: !this.#loaded ? (this.#storeFailing ? 'unavailable' : 'loading') : this.#endReason ? 'complete' : this.#storeFailing ? 'unavailable' : 'active',
      startedAt: started,
      deadlineAt: started === null ? null : started + this.#options.durationMs,
      endedAt: this.#endedAt,
      endReason: this.#endReason,
      chargedResidentialBytes: this.#charged(),
      maxResidentialBytes: this.#options.maxResidentialBytes,
      targetAttempts: this.#options.targetAttempts,
      routes,
      after: structuredClone(this.#after),
    };
  }
}
