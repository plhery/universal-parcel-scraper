import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepAdapterHolds, resetAdapterHolds, type AdapterHold } from './holds.js';
import { ReadWindow } from './readWindow.js';

describe('ReadWindow', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits for a turn the lookup has time for, and otherwise fails as our own pacing', async () => {
    vi.useFakeTimers();
    const window = () => new ReadWindow('Example', 'example wait', 1, 10_000);
    await window().take(20_000);
    // The next turn comes in ten seconds: a lookup with twenty left waits for it.
    let waited = false;
    const second = window().take(20_000).then(() => { waited = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(waited).toBe(true);
    // One with five seconds left would not have time for the read after the wait.
    await expect(window().take(5_000)).rejects.toMatchObject({ kind: 'rate_limited', reason: 'self_paced', retryAfterMs: 10_000 });
  });

  it("saves the window's reads to the host's holds, and counts saved ones after a restart", async () => {
    const saved: AdapterHold[] = [];
    await keepAdapterHolds({ load: async () => [], save: async (hold) => { saved.push(hold); } });
    try {
      const before = Date.now();
      await new ReadWindow('Example', 'example saved', 2, 10_000).take(20_000);
      expect(saved).toEqual([{ key: 'read-window/example saved', until: expect.any(Number), value: [expect.any(Number)] }]);
      expect(saved[0]!.until - (saved[0]!.value as number[])[0]!).toBe(10_000);
      // A process that starts within the window counts the reads saved before it, and drops ones it cannot read.
      await keepAdapterHolds({ load: async () => [{ key: 'read-window/example restarted', until: before + 10_000,
        value: [before, before, 'soon', Date.now() + 60_000] }], save: async () => undefined });
      await expect(new ReadWindow('Example', 'example restarted', 1, 10_000).take(1_000)).rejects.toMatchObject({ kind: 'rate_limited' });
    } finally {
      resetAdapterHolds();
    }
  });

  it('counts each read a saved window took in the same millisecond, once', async () => {
    try {
      // Correios's seven browser reads in a minute, all sent in one millisecond before a restart.
      const at = Date.now();
      await keepAdapterHolds({ load: async () => [{ key: 'read-window/example same ms', until: at + 60_000, value: Array<number>(7).fill(at) }],
        save: async () => undefined });
      await expect(new ReadWindow('Example', 'example same ms', 7, 60_000).take(1_000)).rejects.toMatchObject({ kind: 'rate_limited' });
      // Loaded again over the reads the process already counts, the same reads are not counted twice.
      const saved: AdapterHold[] = [];
      await keepAdapterHolds({ load: async () => [], save: async (hold) => { saved.push(hold); } });
      const live = new ReadWindow('Example', 'example overlap', 3, 60_000);
      await Promise.all([live.take(1_000), live.take(1_000)]);
      const last = saved.at(-1)!;
      await keepAdapterHolds({ load: async () => [last], save: async () => undefined });
      await expect(live.take(1_000)).resolves.toBeUndefined();
      await expect(live.take(1_000)).rejects.toMatchObject({ kind: 'rate_limited' });
    } finally {
      resetAdapterHolds();
    }
  });

  it('releases an aborted wait and caps concurrent reads when the window opens', async () => {
    vi.useFakeTimers();
    const window = () => new ReadWindow('Example', 'example abort', 1, 10_000);
    await window().take(20_000);
    const controller = new AbortController();
    const cut = window().take(20_000, controller.signal);
    controller.abort();
    await expect(cut).rejects.toMatchObject({ kind: 'rate_limited', reason: 'self_paced' });
    const contenders = Promise.allSettled([window().take(15_000), window().take(15_000)]);
    await vi.advanceTimersByTimeAsync(10_000);
    const outcomes = await contenders;
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ reason: { retryAfterMs: 10_000 } });
  });
});
