import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The confirmed public sample, unless a number is given outside the repository.
const sample = (corpus.records as { number: string; quarantine?: boolean; context?: { assessment?: string } }[])
  .find((record) => record.context?.assessment === 'confirmed' && !record.quarantine);
const number = process.env.PAKET_CL_TRACKING_NUMBER ?? sample?.number;

describe('Paket live retrieval', () => {
  it('retrieves the history of the requested parcel', async () => {
    expect(number).toBeDefined();
    const result = await direct().track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    // Every row has wording and a wall clock, dated on Santiago's clock and saying so.
    expect(result.events!.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[34]:00$/.test(String(event.time))
      && event.time_zone === 'America/Santiago' && event.time_zone_basis === 'carrier')).toBe(true);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('receiver_address');
  }, 45_000);

  it('reads a synthetic number of Paket\'s shape as not found', async () => {
    await expect(direct().track({ number: process.env.PAKET_CL_UNKNOWN_NUMBER ?? '970318264' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
