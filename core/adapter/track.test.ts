import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, lookupBudget, type AdapterEnvironment } from './index.js';
import { TransportError } from '../errors/index.js';
import { trackCarrier } from './track.js';
import { NOOP_RECORDER } from '../telemetry/index.js';
import type { UniversalTracker } from '../../providers/universal.js';

const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER };

describe('consumer dispatch', () => {
  it('forwards parcel inputs and cancellation through the mapped adapter', async () => {
    const track = vi.fn().mockResolvedValue({ status: 'delivered', current_stage: 'delivered' });
    const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', steps: ['direct'], track }) },
      carriers: { alias: 'test' } }, environment);
    const signal = new AbortController().signal;
    const result = await trackCarrier('alias', { number: 'TEST0001', postcode: '00000' }, {
      registry, signal, universal: {} as UniversalTracker,
    });
    expect(result.current_stage).toBe('delivered');
    expect(track).toHaveBeenCalledWith({ number: 'TEST0001', postcode: '00000' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('records one lookup and leaves an adapter that owns its steps to record them', async () => {
    const recorder = { ...NOOP_RECORDER, lookup: vi.fn(), step: vi.fn() };
    for (const recordsSteps of [false, true]) {
      recorder.lookup.mockClear();
      const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', recordsSteps,
        steps: ['direct'], track: async () => ({ status: 'in_transit' }) }) }, carriers: { test: 'test' } }, environment);
      await trackCarrier('test', { number: 'TEST0001' }, { registry, recorder, universal: {} as UniversalTracker });
      expect(recorder.lookup).toHaveBeenCalledTimes(recordsSteps ? 0 : 1);
    }
  });

  it('answers a cancelled lookup with the caller\'s reason and a spent budget with a budget failure', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    for (const recordsSteps of [false, true]) {
      const track = vi.fn().mockImplementation(async () => { controller.abort(reason); throw new TransportError('Test', 'interrupted'); });
      const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', recordsSteps, steps: ['direct'], track }) },
        carriers: { test: 'test' } }, environment);
      await expect(trackCarrier('test', { number: 'TEST0001' }, { registry, signal: controller.signal, universal: {} as UniversalTracker }))
        .rejects.toBe(reason);
    }
    const track = vi.fn();
    const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', steps: ['direct'], track }) }, carriers: { test: 'test' } }, environment);
    for (const budgetMs of [0, -5]) {
      await expect(trackCarrier('test', { number: 'TEST0001' }, { registry, budgetMs, universal: {} as UniversalTracker }))
        .rejects.toMatchObject({ kind: 'budget' });
    }
    await expect(trackCarrier('test', { number: 'TEST0001' }, { registry, budgetMs: Number.NaN, universal: {} as UniversalTracker }))
      .rejects.toThrow(TypeError);
    expect(track).not.toHaveBeenCalled();
  });

  it('gives a lookup one signal and one clock, and types a budget that is already spent', async () => {
    expect(() => lookupBudget({ signal: AbortSignal.abort(new Error('caller cancelled')) }, 1_000)).toThrow('caller cancelled');
    for (const spent of [0, -1]) expect(() => lookupBudget({ budgetMs: spent }, 1_000, 'dpd')).toThrow(expect.objectContaining({ kind: 'budget', provider: 'dpd' }));
    for (const unusable of [Number.NaN, Infinity]) expect(() => lookupBudget({ budgetMs: unusable }, 1_000)).toThrow(TypeError);
    const budget = lookupBudget({}, 250);
    expect(budget.budgetMs).toBe(250);
    expect(budget.remainingMs()).toBeGreaterThan(200);
    expect(budget.remainingMs()).toBeLessThanOrEqual(250);
    // A budget longer than a timer can hold is one that never ends the lookup, not one that ends it at once.
    for (const long of [2 ** 31, 2 ** 40]) {
      const held = lookupBudget({ budgetMs: long }, 1_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(held.signal.aborted).toBe(false);
      expect(held.remainingMs()).toBeGreaterThan(2 ** 31 - 1_000);
      expect(held.remainingMs()).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });

  it('uses the consumer-configured universal chain only for universal carriers', async () => {
    const universal = { fetch: vi.fn().mockResolvedValue({ status: 'in_transit' }) } as unknown as UniversalTracker;
    const registry = new AdapterRegistry({ factories: {}, carriers: { test: 'universal', manual: null } }, environment);
    const signal = new AbortController().signal;
    await trackCarrier('test', { number: 'TEST0001', postcode: '00000', countryHint: 'FR' }, { registry, universal, signal, budgetMs: 5_000 });
    expect(universal.fetch).toHaveBeenCalledExactlyOnceWith('TEST0001', '00000', { signal, budgetMs: 5_000 }, 'FR');
    await expect(trackCarrier('manual', { number: 'TEST0001' }, { registry, universal })).rejects.toThrow('No tracking adapter');
  });
});
