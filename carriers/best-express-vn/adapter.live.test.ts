import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

// A public sample (source in numbers.json); BEST_EXPRESS_VN_TRACKING_NUMBER tracks another shipment.
const NUMBER = process.env.BEST_EXPRESS_VN_TRACKING_NUMBER || '84859234749299';
const steps: string[] = [];
const recorder = { ...NOOP_RECORDER, step: (step: { step: string; outcome: string }) => { steps.push(`${step.step}:${step.outcome}`); } };
const instance = () => adapter({ fetcher: fetch, env: {}, recorder, trawl: null, browserExecutablePath: null });

describe('BEST Express Vietnam live tracker', () => {
  it('reads the history of a real number past its picture verification', async () => {
    steps.length = 0;
    const result = await instance().track({ number: NUMBER }, { budgetMs: 45_000 });
    expect(steps).toEqual(['direct:ok']);
    expect(result.events!.length).toBeGreaterThan(1);
    expect(result.status).not.toBe('unknown');
    for (const event of result.events!) {
      expect(event.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
      expect(event.description).toMatch(/^[^【】<>]{1,400}$/);
    }
  }, 60_000);

  it('answers a well-formed unknown number with a clean not-found', async () => {
    await expect(instance().track({ number: '00000000000000' }, { budgetMs: 45_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
