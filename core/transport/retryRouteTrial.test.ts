import { expect, it } from 'vitest';
import { RetryRouteTrial, memoryRetryRouteTrialStore, type RetryRouteTrialStore } from './retryRouteTrial.js';

const HOUR = 3_600_000;
const MB = 1_000_000;

function trial(store: RetryRouteTrialStore, clock: { now: number }, overrides: Partial<ConstructorParameters<typeof RetryRouteTrial>[0]> = {}) {
  let seed = 7;
  // A fixed pseudo-random sequence, so runs repeat.
  const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  return new RetryRouteTrial({ id: 'test-trial', store, targetAttempts: 100, maxResidentialBytes: 250 * MB,
    durationMs: 48 * HOUR, allowanceBytes: 10 * MB, marginBytes: MB, now: () => clock.now, random, ...overrides });
}

it('keeps assignment balanced whatever the outcomes, leases every trial attempt and ends at the sample target', async () => {
  const clock = { now: 1_000 }, store = memoryRetryRouteTrialStore(() => clock.now), subject = trial(store, clock, { maxResidentialBytes: 10_000 * MB });
  for (let i = 0; i < 150; i++) {
    clock.now += 60_000;
    const { route, lease, settle } = await subject.assign();
    expect(lease).toMatchObject({ allowanceBytes: 10 * MB });
    // Outcomes favour one route; the assignment must not follow them.
    settle({ outcome: route === 'residential' ? 'ok' : 'challenge', history: route === 'residential', bytes: MB, verified: true });
    const { routes } = subject.snapshot();
    expect(Math.abs(routes.datacenter.attempts - routes.residential.attempts)).toBeLessThanOrEqual(10);
  }
  expect(subject.snapshot()).toMatchObject({ phase: 'active', endReason: null });
  for (let i = 0; i < 100; i++) {
    clock.now += 60_000;
    const { route, settle } = await subject.assign();
    settle({ outcome: route === 'residential' ? 'ok' : 'challenge', history: route === 'residential', bytes: MB, verified: true });
  }
  const snapshot = subject.snapshot();
  expect(snapshot).toMatchObject({ phase: 'complete', endReason: 'samples' });
  expect(snapshot.routes.residential.attempts).toBe(100);
  expect(snapshot.routes.residential.history).toBe(100);
  expect(snapshot.chargedResidentialBytes).toBe(100 * 2 * MB);
  await subject.flush();
  const rows = store.rows.size;
  expect(rows).toBe(snapshot.routes.datacenter.attempts + snapshot.routes.residential.attempts);
  // After the end, retries take the datacenter route without a lease and are not saved.
  for (let i = 0; i < 5; i++) expect(await subject.assign()).toMatchObject({ route: 'datacenter', lease: null });
  await subject.flush();
  expect(store.rows.size).toBe(rows);
  const before = subject.snapshot().after;
  const late = await subject.assign(); late.settle({ outcome: 'ok', history: true, bytes: 10 });
  expect(subject.snapshot().after).toMatchObject({ attempts: before.attempts + 1, history: before.history + 1, bytes: before.bytes + 10 });
});

it('returns a residential route only after the store saved its reservation, and never waits past the budget', async () => {
  const clock = { now: 0 };
  const memory = memoryRetryRouteTrialStore(() => clock.now);
  let saved = 0, reserves = 0;
  // The reservation never answers: no residential route, and the assignment returns within its budget.
  const pending: RetryRouteTrialStore = { ...memory, save: async attempt => { saved++; await memory.save(attempt); },
    reserve: () => { reserves++; return new Promise(() => {}); } };
  const subject = trial(pending, clock, { storeTimeoutMs: 20, reloadMs: 1_000 });
  const started = performance.now();
  for (let i = 0; i < 20; i++) expect((await subject.assign({ budgetMs: 1_000 })).route).toBe('datacenter');
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(reserves).toBe(1);
  expect(subject.snapshot()).toMatchObject({ phase: 'unavailable' });
  await subject.flush();
  // The reservation that might still land is marked unused; it is neither a sample nor a charge.
  expect([...memory.rows.values()].filter(row => row.route === 'residential')).toEqual([]);
  expect(subject.snapshot().routes.residential).toMatchObject({ attempts: 0 });
  expect(saved).toBeGreaterThan(19);

  // A failing reservation is no residential route either.
  const failing = trial({ ...memory, reserve: async () => { throw new Error('offline'); } }, clock);
  const routes = new Set<string>();
  for (let i = 0; i < 20; i++) routes.add((await failing.assign()).route);
  expect([...routes]).toEqual(['datacenter']);

  // A store that does not answer at all, or a budget that leaves no time to wait, is the datacenter route at once.
  const silent = trial({ load: () => new Promise(() => {}), save: async () => {}, reserve: () => new Promise(() => {}), end: async () => {} }, clock, { storeTimeoutMs: 5 });
  expect((await silent.assign()).route).toBe('datacenter');
  const hurried = trial(memoryRetryRouteTrialStore(() => clock.now), clock);
  for (let i = 0; i < 10; i++) expect((await hurried.assign({ budgetMs: 0 })).route).toBe('datacenter');
});

it('keeps the residential route closed for a while after a failed write', async () => {
  const clock = { now: 0 }, memory = memoryRetryRouteTrialStore(() => clock.now);
  let failing = false;
  const store: RetryRouteTrialStore = { ...memory, save: async attempt => { if (failing) throw new Error('offline'); await memory.save(attempt); } };
  const subject = trial(store, clock, { reloadMs: 60_000 });
  await subject.load();
  failing = true;
  let first = await subject.assign();
  while (first.route !== 'datacenter') { first.settle({ outcome: 'ok', history: true, bytes: 1, verified: true }); first = await subject.assign(); }
  await subject.flush();
  expect(subject.snapshot()).toMatchObject({ phase: 'unavailable' });
  failing = false;
  // A write that succeeds at once does not reopen it before the pause is over.
  for (let i = 0; i < 20; i++) { expect((await subject.assign()).route).toBe('datacenter'); await subject.flush(); }
  expect(subject.snapshot()).toMatchObject({ phase: 'unavailable' });
  clock.now += 60_000;
  expect(subject.snapshot()).toMatchObject({ phase: 'active' });
  const routes = new Set<string>();
  for (let i = 0; i < 20; i++) { const assignment = await subject.assign(); routes.add(assignment.route); assignment.settle({ outcome: 'ok', history: true, bytes: 1, verified: true }); }
  expect(routes.has('residential')).toBe(true);
});

it('never lets the charges pass the cap, whatever the replies carry', async () => {
  const clock = { now: 0 }, store = memoryRetryRouteTrialStore(() => clock.now);
  const subject = trial(store, clock, { maxResidentialBytes: 60 * MB });
  let residential = 0;
  // Worst cases in turn: a lost reply, a reply cut at its allowance, a reply the worker could not vouch for, a normal one.
  const replies = [
    {},
    { bytes: 10 * MB + 65_536, verified: true, limited: true },
    { bytes: 3 * MB, verified: false },
    { bytes: 4 * MB, verified: true },
  ];
  for (let i = 0; i < 60 && subject.snapshot().phase !== 'complete'; i++) {
    clock.now += 60_000;
    const { route, lease, settle } = await subject.assign();
    if (route === 'residential') {
      expect(store.rows.get(lease!.id)).toMatchObject({ route: 'residential', reservedBytes: 11 * MB });
      settle({ outcome: 'transport', history: false, ...replies[residential++ % replies.length] });
    } else settle({ outcome: 'ok', history: true, bytes: MB, verified: true });
  }
  await subject.flush();
  const snapshot = subject.snapshot();
  expect(snapshot).toMatchObject({ phase: 'complete', endReason: 'bytes' });
  // 11 + (10 MB + 64 KiB + 1) + 11 + 5 + 11 ...: each attempt's worst case was reserved before it began.
  expect(snapshot.chargedResidentialBytes).toBeLessThanOrEqual(60 * MB);
  expect(snapshot.chargedResidentialBytes + 11 * MB).toBeGreaterThan(60 * MB);
  const charges = [...store.rows.values()].filter(row => row.route === 'residential').map(row => row.chargedBytes);
  expect(charges.slice(0, 4)).toEqual([11 * MB, 11 * MB + 65_536, 11 * MB, 5 * MB]);
  expect(snapshot.routes.residential.outcomes).toMatchObject({ byte_allowance: expect.any(Number) });
  // Once ended for bytes, a lower settlement does not open the route again.
  for (const row of store.rows.values()) if (row.route === 'residential') row.chargedBytes = 0;
  const reloaded = trial(store, clock, { maxResidentialBytes: 60 * MB });
  for (let i = 0; i < 10; i++) expect((await reloaded.assign()).route).toBe('datacenter');
  expect(reloaded.snapshot()).toMatchObject({ phase: 'complete', endReason: 'bytes' });
});

it('holds one residential lease at a time across processes sharing the store, and never oversubscribes it', async () => {
  const clock = { now: 0 }, store = memoryRetryRouteTrialStore(() => clock.now);
  // Two deployments overlap, each with its own counters, against a budget of three reservations.
  const a = trial(store, clock, { maxResidentialBytes: 33 * MB }), b = trial(store, clock, { maxResidentialBytes: 33 * MB });
  const running: Array<{ settle: (r: { outcome: string; history: boolean }) => void }> = [];
  for (let i = 0; i < 40; i++) {
    clock.now += 1_000;
    const assignment = await (i % 2 ? a : b).assign();
    if (assignment.route === 'residential') running.push(assignment);
    // Nobody settles: each lease stays open until it is older than the lease time.
    expect(running.length).toBeLessThanOrEqual(1 + Math.floor(clock.now / 180_000));
  }
  expect(running.length).toBe(1);
  for (let i = 0; i < 2_000; i++) {
    clock.now += 10_000;
    const assignment = await (i % 2 ? a : b).assign();
    if (assignment.route === 'residential') running.push(assignment);
  }
  // Lost attempts are charged their whole reservation, so the budget holds three and the trial ends.
  expect(running.length).toBe(3);
  const residential = [...store.rows.values()].filter(row => row.route === 'residential');
  expect(residential.reduce((sum, row) => sum + row.chargedBytes!, 0)).toBe(33 * MB);
  expect(store.trials.get('test-trial')?.end).toMatchObject({ reason: 'bytes' });
});

it('keeps its counts, charges, start and end across a restart', async () => {
  const clock = { now: 0 }, store = memoryRetryRouteTrialStore(() => clock.now);
  const first = trial(store, clock);
  for (let i = 0; i < 10; i++) {
    const { settle } = await first.assign(); clock.now += HOUR;
    settle({ outcome: 'ok', history: true, bytes: 1_000, verified: true });
  }
  // A process that stopped mid-attempt leaves it unsettled: it counts, at its reservation.
  let open = await first.assign();
  while (open.route !== 'residential') { open.settle({ outcome: 'ok', history: true }); open = await first.assign(); }
  await first.flush();
  const before = first.snapshot();
  const second = trial(store, clock);
  await second.load();
  const after = second.snapshot();
  expect(after.routes).toEqual(before.routes);
  expect(after.startedAt).toBe(0);
  expect(after.chargedResidentialBytes).toBe(before.chargedResidentialBytes);
  expect(after.reservedResidentialBytes).toBe(11 * MB);
  clock.now = 48 * HOUR;
  expect(second.snapshot()).toMatchObject({ phase: 'complete', endReason: 'deadline', endedAt: 48 * HOUR });
  expect((await second.assign()).route).toBe('datacenter');
  // The store recorded the end once a reservation found it; a later process stays ended.
  const third = trial(store, clock);
  clock.now = 47 * HOUR;
  expect(await third.assign()).toMatchObject({ route: 'datacenter' });
  await third.flush();
  // Another trial name starts again.
  const next = trial(store, clock, { id: 'next-trial' });
  await next.load();
  expect(next.snapshot()).toMatchObject({ phase: 'active', startedAt: null });
});

it('ends for good at the deadline even when the clock moves back', async () => {
  const clock = { now: 0 }, store = memoryRetryRouteTrialStore(() => clock.now);
  const subject = trial(store, clock);
  let assignment = await subject.assign();
  while (assignment.route !== 'residential') { assignment.settle({ outcome: 'ok', history: true }); assignment = await subject.assign(); }
  assignment.settle({ outcome: 'ok', history: true, bytes: 1, verified: true });
  clock.now = 49 * HOUR;
  const other = trial(store, clock, { random: () => 0.99 });
  await other.load();
  // The coin may still say residential: the store refuses it and records the end.
  for (let i = 0; i < 5; i++) expect((await other.assign()).route).toBe('datacenter');
  clock.now = HOUR;
  const later = trial(store, clock);
  for (let i = 0; i < 10; i++) expect((await later.assign()).route).toBe('datacenter');
  expect(store.trials.get('test-trial')?.end).toMatchObject({ reason: 'deadline', at: 48 * HOUR });
});

it('rejects names and limits that cannot be stored or reached', () => {
  const store = memoryRetryRouteTrialStore();
  expect(() => trial(store, { now: 0 }, { id: 'a b' })).toThrow(TypeError);
  expect(() => trial(store, { now: 0 }, { targetAttempts: 0 })).toThrow(TypeError);
  expect(() => trial(store, { now: 0 }, { durationMs: Number.NaN })).toThrow(TypeError);
  expect(() => trial(store, { now: 0 }, { allowanceBytes: 0 })).toThrow(TypeError);
  expect(() => trial(store, { now: 0 }, { marginBytes: -1 })).toThrow(TypeError);
  expect(() => trial(store, { now: 0 }, { maxResidentialBytes: 10 * MB })).toThrow(TypeError);
});
