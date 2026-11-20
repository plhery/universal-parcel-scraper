import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

// A public sample (source in numbers.json); VNPOST_TRACKING_NUMBER tracks another item.
const NUMBER = process.env.VNPOST_TRACKING_NUMBER || 'EK572324490VN';
const steps: string[] = [];
const recorder = { ...NOOP_RECORDER, step: (step: { step: string; outcome: string }) => { steps.push(`${step.step}:${step.outcome}`); } };
const instance = () => adapter({ fetcher: fetch, env: {}, recorder, trawl: null, browserExecutablePath: null });

describe('VNPost live tracker', () => {
  it('reads the history of a real number past its captcha', async () => {
    steps.length = 0;
    const result = await instance().track({ number: NUMBER }, { budgetMs: 40_000 });
    expect(steps).toEqual(['direct:ok']);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.last_update).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
    expect(result.status).not.toBe('unknown');
    for (const event of result.events!) expect(event.description).toMatch(/^[^<>]{1,400}$/);
  }, 60_000);

  it('answers a well-formed unknown number with a clean not-found', async () => {
    await expect(instance().track({ number: 'RR000000005VN' }, { budgetMs: 40_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
