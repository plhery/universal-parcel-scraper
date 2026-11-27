import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// No public Blackhaul number is known: a consignment is given outside the repository.
const number = process.env.BLACKHAUL_TRACKING_NUMBER;

describe('Blackhaul live retrieval', () => {
  it.skipIf(!number)('retrieves the history of the requested consignment', async () => {
    const result = await direct().track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    for (const field of ['receiver_address', 'receiver_name', 'signed_by']) expect(result).not.toHaveProperty(field);
  }, 45_000);

  it('reads a synthetic number as inconclusive, not as a missing consignment', async () => {
    await expect(direct().track({ number: process.env.BLACKHAUL_UNKNOWN_NUMBER ?? 'ZQX0000000017' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 45_000);
});
