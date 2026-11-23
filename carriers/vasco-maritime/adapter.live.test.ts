import { describe, expect, it } from 'vitest';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const number = process.env.VASCO_MARITIME_TRACKING_NUMBER ?? numbers.records[0]!.number;
const unknown = process.env.VASCO_MARITIME_UNKNOWN_NUMBER;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

// The tracker's host never takes a connection from some networks, GitHub's runners
// included, while others get the answer: that proves neither breakage nor health.
// A failed name lookup, a bad certificate or a reply that breaks still fails.
const UNANSWERED = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'EHOSTUNREACH']);
const REFUSED = 'Vasco Maritime\'s tracker did not answer this network: the lookup remains unverified';

function unanswered(error: unknown, depth = 0): boolean {
  if (depth > 8 || !(error instanceof Error)) return false;
  return UNANSWERED.has(String((error as { code?: unknown }).code)) || unanswered(error.cause, depth + 1);
}

describe('Vasco Maritime live tracker', () => {
  it('returns the containers’ moves on the ports’ wall clocks', async (context) => {
    let result: CarrierResult;
    try {
      result = await tracker().track({ number });
    } catch (error) {
      if (error instanceof UpstreamNetworkError && unanswered(error)) return context.skip(REFUSED);
      throw error;
    }
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description && event.provider_code)).toBe(true);
  }, 60_000);
  it.skipIf(!unknown)('reads an unknown number as not found', async (context) => {
    const error: unknown = await tracker().track({ number: unknown! }).then(() => undefined, caught => caught);
    if (error instanceof UpstreamNetworkError && unanswered(error)) return context.skip(REFUSED);
    expect(error).toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
