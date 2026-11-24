import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The confirmed public sample, unless a number is given outside the repository.
const sample = (corpus.records as { number: string; quarantine?: boolean; context?: { assessment?: string } }[])
  .find((record) => record.context?.assessment === 'confirmed' && !record.quarantine);
const number = process.env.DELIVRO_TRACKING_NUMBER ?? sample?.number;

describe('Délivro live retrieval', () => {
  it('retrieves the checkpoints of the requested order, in English, at the offsets the tracker states', async () => {
    expect(number).toBeDefined();
    const result = await direct().track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time))
      && event.local_time === undefined)).toBe(true);
    expect(result.events!.some((event) => event.stage_source === 'carrier_map' && /^Order /.test(event.description!))).toBe(true);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('receiver_address');
  }, 45_000);

  it('reads a synthetic order id of Délivro\'s shape as not found', async () => {
    await expect(direct().track({ number: process.env.DELIVRO_UNKNOWN_NUMBER ?? 'DEL9640731' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
