import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const steps: string[] = [];
const recorder = { ...NOOP_RECORDER, step: (step: { step: string; outcome: string }) => { steps.push(`${step.step}:${step.outcome}`); } };
const instance = () => adapter({ fetcher: fetch, env: {}, recorder, trawl: null, browserExecutablePath: null });

describe('Hongkong Post live tracker', () => {
  it('answers a well-formed unknown number with a clean not-found', async () => {
    await expect(instance().track({ number: 'RR000000005HK' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);

  it.skipIf(!process.env.HONGKONG_POST_TRACKING_NUMBER)('reads the history of a real number past its verification', async () => {
    steps.length = 0;
    const result = await instance().track({ number: process.env.HONGKONG_POST_TRACKING_NUMBER! });
    // The chatbot's summary answers only when the tracker's verification fails.
    expect(steps).toEqual(['website:ok']);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.last_update_local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    for (const event of result.events!) expect(event.description).toMatch(/^[^<>]{1,300}$/);
    expect(result.status).not.toBe('unknown');
    expect(JSON.stringify(result)).not.toMatch(/https?:|eform|Signed|Recipient|Addressee/i);
  }, 60_000);
});
