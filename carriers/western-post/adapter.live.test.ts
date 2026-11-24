import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The confirmed public sample, unless a number is given outside the repository.
const sample = (corpus.records as { number: string; quarantine?: boolean; context?: { assessment?: string } }[])
  .find((record) => record.context?.assessment === 'confirmed' && !record.quarantine);
const number = process.env.WESTERN_POST_TRACKING_NUMBER ?? sample?.number;

describe('Western Post live retrieval', () => {
  it('retrieves the history of the requested parcel', async () => {
    expect(number).toBeDefined();
    const result = await direct().track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    // Every scan has wording, a code and a wall clock without an offset.
    expect(result.events!.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && event.time === undefined)).toBe(true);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('receiver_address');
  }, 45_000);

  it('reads a synthetic number of the sample\'s shape as not found', async () => {
    await expect(direct().track({ number: process.env.WESTERN_POST_UNKNOWN_NUMBER ?? 'WP9031846275019' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
