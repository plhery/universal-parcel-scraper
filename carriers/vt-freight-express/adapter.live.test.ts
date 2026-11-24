import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The confirmed public sample the tracker still finds, unless a number is given outside the repository.
const sample = (corpus.records as { number: string; quarantine?: boolean; source?: { url: string }; context?: { assessment?: string } }[])
  .find((record) => record.context?.assessment === 'confirmed' && !record.quarantine && record.source?.url.includes('parcelpanel'));
const number = process.env.VT_FREIGHT_EXPRESS_TRACKING_NUMBER ?? sample?.number;

describe('VT Freight Express live retrieval', () => {
  it('retrieves the history of the requested consignment', async () => {
    expect(number).toBeDefined();
    const result = await direct().track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    // Scan rows carry instants from their ticks, and timed rows the zone the page names.
    expect(result.events!.every((event) => event.description && typeof event.time === 'string'
      && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time))).toBe(true);
    for (const field of ['receiver_address', 'receiver_name', 'signed_by']) expect(result).not.toHaveProperty(field);
  }, 45_000);

  it('reads a synthetic number of the sample\'s shape as inconclusive, not as a missing consignment', async () => {
    await expect(direct().track({ number: process.env.VT_FREIGHT_EXPRESS_UNKNOWN_NUMBER ?? 'ZZZ5830291746' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 45_000);
});
