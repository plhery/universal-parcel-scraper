import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoldKind, keepAdapterHolds, resetAdapterHolds, serviceTag, type AdapterHold } from './holds.js';

describe('adapter holds', () => {
  afterEach(() => resetAdapterHolds());

  it('saves nothing until the host keeps holds, then saves each hold under its kind', async () => {
    const kind = new HoldKind('example-save', () => undefined);
    kind.save('a', Date.now() + 1_000);
    const saved: AdapterHold[] = [];
    await keepAdapterHolds({ load: async () => [], save: async (hold) => { saved.push(hold); } });
    kind.save('a', 5, ['x']);
    kind.save('b', Number.NaN);
    expect(saved).toEqual([{ key: 'example-save/a', until: 5, value: ['x'] }]);
  });

  it('takes up the running holds of every kind, including one whose module registers later', async () => {
    const now = Date.now();
    const early = vi.fn();
    new HoldKind('example-early', early);
    const taken = await keepAdapterHolds({ load: async () => [
      { key: 'example-early/one two', until: now + 1_000, value: 1 },
      { key: 'example-late/x', until: now + 1_000 },
      { key: 'example-early/over', until: now - 1 },
      { key: 'no-kind', until: now + 1_000 },
      { key: 'example-early/bad', until: 'soon' } as unknown as AdapterHold,
      null as unknown as AdapterHold,
    ], save: async () => undefined });
    expect(taken).toBe(2);
    expect(early).toHaveBeenCalledExactlyOnceWith('one two', now + 1_000, 1);
    const late = vi.fn();
    new HoldKind('example-late', late);
    expect(late).toHaveBeenCalledExactlyOnceWith('x', now + 1_000, undefined);
  });

  it('carries on when the store fails or a saved hold cannot be read', async () => {
    new HoldKind('example-broken', () => { throw new Error('unreadable'); });
    await expect(keepAdapterHolds({ load: async () => [{ key: 'example-broken/a', until: Date.now() + 1_000 }],
      save: async () => { throw new Error('down'); } })).resolves.toBe(1);
    expect(() => new HoldKind('example-failing', () => undefined).save('a', Date.now())).not.toThrow();
    const save = vi.fn(async () => undefined);
    await expect(keepAdapterHolds({ load: async () => { throw new Error('down'); }, save })).rejects.toThrow('down');
    // New holds are still saved when the saved ones could not be loaded.
    new HoldKind('example-after', () => undefined).save('a', 1);
    expect(save).toHaveBeenCalledOnce();
    expect(() => new HoldKind('Example Kind', () => undefined)).toThrow(TypeError);
  });

  it('tags a service the same way each time, without its address', () => {
    expect(serviceTag('https://user:secret@browser.example.test/a')).toBe(serviceTag('https://user:secret@browser.example.test/a'));
    expect(serviceTag('https://browser.example.test/a')).not.toBe(serviceTag('https://browser.example.test/b'));
    expect(serviceTag('https://browser.example.test/a')).toMatch(/^[0-9a-z]{1,7}$/);
  });
});
