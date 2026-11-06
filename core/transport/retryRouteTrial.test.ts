import { expect, it } from 'vitest';
import { RetryRouteTrial, type RetryRouteAttempt, type RetryRouteTrialStore } from './retryRouteTrial.js';

function memoryStore(saved: RetryRouteAttempt[] = []): RetryRouteTrialStore & { rows: Map<string, RetryRouteAttempt> } {
  const rows = new Map(saved.map(attempt => [attempt.id, attempt]));
  return { rows, load: async trial => [...rows.values()].filter(row => row.trial === trial), save: async attempt => { rows.set(attempt.id, { ...attempt }); } };
}

const HOUR = 3_600_000;
function trial(store: RetryRouteTrialStore, clock: { now: number }, overrides: Partial<ConstructorParameters<typeof RetryRouteTrial>[0]> = {}) {
  let seed = 7;
  // A fixed pseudo-random sequence, so runs repeat.
  const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  return new RetryRouteTrial({ id: 'test-trial', store, targetAttempts: 100, maxResidentialBytes: 250_000_000,
    durationMs: 48 * HOUR, unmeasuredBytes: 2_000_000, now: () => clock.now, random, ...overrides });
}

it('keeps assignment balanced whatever the outcomes, and ends at the sample target', async () => {
  const store = memoryStore(), clock = { now: 1_000 }, subject = trial(store, clock);
  for (let i = 0; i < 150; i++) {
    clock.now += 60_000;
    const { route, settle } = await subject.assign();
    // Outcomes favour one route; the assignment must not follow them.
    settle({ outcome: route === 'residential' ? 'ok' : 'challenge', history: route === 'residential', bytes: route === 'residential' ? 1_000_000 : 50_000 });
    const { routes } = subject.snapshot();
    expect(Math.abs(routes.datacenter.attempts - routes.residential.attempts)).toBeLessThanOrEqual(10);
  }
  let snapshot = subject.snapshot();
  expect(snapshot).toMatchObject({ phase: 'active', endReason: null });
  for (let i = 0; i < 100; i++) {
    const { route, settle } = await subject.assign();
    settle({ outcome: route === 'residential' ? 'ok' : 'challenge', history: route === 'residential', bytes: 1_000_000 });
  }
  snapshot = subject.snapshot();
  expect(snapshot).toMatchObject({ phase: 'complete', endReason: 'samples' });
  expect(snapshot.routes.residential.attempts).toBe(100);
  expect(snapshot.routes.residential.history).toBe(snapshot.routes.residential.attempts);
  expect(snapshot.routes.datacenter.outcomes).toEqual({ challenge: snapshot.routes.datacenter.settled - (snapshot.routes.datacenter.history) });
  // After the end, retries take the datacenter route and are not saved.
  await subject.flush();
  const rows = store.rows.size;
  expect(rows).toBe(snapshot.routes.datacenter.attempts + snapshot.routes.residential.attempts);
  for (let i = 0; i < 5; i++) expect((await subject.assign()).route).toBe('datacenter');
  await subject.flush();
  expect(store.rows.size).toBe(rows);
  const before = subject.snapshot().after;
  const late = await subject.assign(); late.settle({ outcome: 'ok', history: true, bytes: 10 });
  expect(subject.snapshot().after).toMatchObject({ attempts: before.attempts + 1, history: before.history + 1, bytes: before.bytes + 10 });
});

it('stops residential before its next attempt could pass the byte cap, charging attempts without proof', async () => {
  const store = memoryStore(), clock = { now: 0 }, subject = trial(store, clock, { maxResidentialBytes: 10_000_000 });
  let residential = 0;
  for (let i = 0; i < 40 && subject.snapshot().phase !== 'complete'; i++) {
    const { route, settle } = await subject.assign();
    if (route === 'residential') residential++;
    // Every other residential attempt is lost in transport and proves no bytes.
    settle({ outcome: 'transport', history: false, ...(route === 'residential' && residential % 2 ? {} : { bytes: 1_500_000 }) });
  }
  const snapshot = subject.snapshot();
  expect(snapshot).toMatchObject({ phase: 'complete', endReason: 'bytes' });
  expect(snapshot.chargedResidentialBytes).toBeLessThanOrEqual(10_000_000);
  expect(snapshot.chargedResidentialBytes + 2_000_000).toBeGreaterThan(10_000_000);
  expect(snapshot.routes.residential.unmeasured).toBeGreaterThan(0);
});

it('keeps its counts, bytes and deadline across a restart, and ends at the deadline', async () => {
  const store = memoryStore(), clock = { now: 0 };
  const first = trial(store, clock);
  for (let i = 0; i < 10; i++) { const { settle } = await first.assign(); clock.now += HOUR; settle({ outcome: 'ok', history: true, bytes: 1_000 }); }
  // A process that stopped mid-attempt leaves it unsettled: it still counts, at the unmeasured charge.
  await first.assign(); await first.flush();
  const before = first.snapshot();
  const second = trial(store, clock);
  await second.load();
  const after = second.snapshot();
  expect(after.routes).toEqual(before.routes);
  expect(after.startedAt).toBe(0);
  expect(after.chargedResidentialBytes).toBe(before.chargedResidentialBytes);
  clock.now = 48 * HOUR;
  expect(second.snapshot()).toMatchObject({ phase: 'complete', endReason: 'deadline', endedAt: 48 * HOUR });
  expect((await second.assign()).route).toBe('datacenter');
  // Another trial name starts again.
  const next = trial(store, clock, { id: 'next-trial' });
  await next.load();
  expect(next.snapshot()).toMatchObject({ phase: 'active', startedAt: null });
});

it('assigns only the datacenter route while the store fails or does not answer, without saving those attempts', async () => {
  const clock = { now: 0 };
  let failing = true;
  const saves: RetryRouteAttempt[] = [];
  const store: RetryRouteTrialStore = {
    load: async () => { if (failing) throw new Error('offline'); return []; },
    save: async attempt => { saves.push(attempt); },
  };
  const subject = trial(store, clock, { reloadMs: 1_000 });
  for (let i = 0; i < 20; i++) expect((await subject.assign()).route).toBe('datacenter');
  expect(subject.snapshot().phase).toBe('unavailable');
  failing = false; clock.now += 1_000;
  const routes = new Set<string>();
  for (let i = 0; i < 20; i++) routes.add((await subject.assign()).route);
  expect([...routes].sort()).toEqual(['datacenter', 'residential']);
  await subject.flush();
  expect(saves.length).toBe(20);

  const silent = trial({ load: () => new Promise(() => {}), save: async () => {} }, clock, { loadTimeoutMs: 5 });
  expect((await silent.assign()).route).toBe('datacenter');
});

it('pauses the residential route after a failed save until one succeeds', async () => {
  const clock = { now: 0 };
  let failing = false;
  const store: RetryRouteTrialStore = { load: async () => [], save: async () => { if (failing) throw new Error('offline'); } };
  const subject = trial(store, clock);
  await subject.load();
  failing = true;
  await subject.assign(); await subject.flush();
  for (let i = 0; i < 10; i++) { expect((await subject.assign()).route).toBe('datacenter'); await subject.flush(); }
  expect(subject.snapshot()).toMatchObject({ phase: 'unavailable' });
  failing = false;
  await subject.assign(); await subject.flush();
  const routes = new Set<string>();
  for (let i = 0; i < 20; i++) routes.add((await subject.assign()).route);
  expect(routes.has('residential')).toBe(true);
  expect(subject.snapshot().routes.datacenter.attempts).toBeGreaterThanOrEqual(12);
});

it('rejects names and limits that cannot be stored or reached', () => {
  const store = memoryStore();
  expect(() => trial(store, { now: 0 }, { id: 'a b' })).toThrow(TypeError);
  expect(() => trial(store, { now: 0 }, { targetAttempts: 0 })).toThrow(TypeError);
  expect(() => trial(store, { now: 0 }, { durationMs: Number.NaN })).toThrow(TypeError);
});
