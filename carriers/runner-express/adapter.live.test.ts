import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The confirmed public sample, unless a number is given outside the repository.
const sample = (corpus.records as { number: string; quarantine?: boolean; context?: { assessment?: string } }[])
  .find((record) => record.context?.assessment === 'confirmed' && !record.quarantine);
const number = process.env.RUNNER_EXPRESS_TRACKING_NUMBER ?? sample?.number;

describe('Runner Express live retrieval', () => {
  it('retrieves the history of the requested parcel', async () => {
    expect(number).toBeDefined();
    const result = await direct().track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    // Every scan has wording and the offset the page states.
    expect(result.events!.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(String(event.time)))).toBe(true);
    for (const field of ['receiver_name', 'receiver_address', 'signed_by']) expect(result).not.toHaveProperty(field);
  }, 45_000);

  it('reads a synthetic number of the sample\'s shape as not found', async () => {
    await expect(direct().track({ number: process.env.RUNNER_EXPRESS_UNKNOWN_NUMBER ?? 'ZYIL3141592653589' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
