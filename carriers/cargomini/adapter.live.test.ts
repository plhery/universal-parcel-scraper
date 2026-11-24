import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The confirmed public sample, unless a number is given outside the repository.
const sample = (corpus.records as { number: string; quarantine?: boolean; context?: { assessment?: string } }[])
  .find((record) => record.context?.assessment === 'confirmed' && !record.quarantine);
const number = process.env.CARGOMINI_TRACKING_NUMBER ?? sample?.number;

describe('CargoMini live retrieval', () => {
  it('retrieves the events of the requested consignment', async () => {
    expect(number).toBeDefined();
    const result = await direct().track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    // Every event has wording, a code and an instant with its offset.
    expect(result.events!.every((event) => event.description && event.provider_code && typeof event.time === 'string')).toBe(true);
    expect(result).not.toHaveProperty('receiver_name');
  }, 45_000);

  it('reads a synthetic number as not found', async () => {
    await expect(direct().track({ number: process.env.CARGOMINI_UNKNOWN_NUMBER ?? '999999999999TR' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
