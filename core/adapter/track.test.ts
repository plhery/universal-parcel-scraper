import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment } from './index.js';
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

  it('uses the consumer-configured universal chain only for universal carriers', async () => {
    const universal = { fetch: vi.fn().mockResolvedValue({ status: 'in_transit' }) } as unknown as UniversalTracker;
    const registry = new AdapterRegistry({ factories: {}, carriers: { test: 'universal', manual: null } }, environment);
    await trackCarrier('test', { number: 'TEST0001', postcode: '00000' }, { registry, universal });
    expect(universal.fetch).toHaveBeenCalledExactlyOnceWith('TEST0001', '00000');
    await expect(trackCarrier('manual', { number: 'TEST0001' }, { registry, universal })).rejects.toThrow('No tracking adapter');
  });
});
