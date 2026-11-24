import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The newest confirmed public sample, since the tracker keeps about six months of parcels, unless a number is given
// outside the repository.
const sample = (corpus.records as { number: string; quarantine?: boolean; source: { date: string }; context?: { assessment?: string } }[])
  .filter((record) => record.context?.assessment === 'confirmed' && !record.quarantine)
  .sort((a, b) => b.source.date.localeCompare(a.source.date))[0];
const number = process.env.OBIBOX_TRACKING_NUMBER ?? sample?.number;

describe('Obibox live retrieval', () => {
  it('retrieves the history of the requested parcel', async () => {
    expect(number).toBeDefined();
    const result = await direct().track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    // Every scan has its code, a description and an instant with its offset.
    expect(result.events!.every((event) => event.provider_code && event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)) && event.location === undefined)).toBe(true);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('receiver_address');
  }, 45_000);

  it('reads a synthetic number of Obibox\'s shape as not found', async () => {
    await expect(direct().track({ number: process.env.OBIBOX_UNKNOWN_NUMBER ?? 'XPSYN1234567890Q1' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
