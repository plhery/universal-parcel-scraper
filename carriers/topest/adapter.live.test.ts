import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker, TrackingError } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.TOPEST_TRACKING_NUMBER ?? numbers.records[0]!.number;

// No place keeps a clock more than fourteen hours ahead of UTC.
const latestWallClock = () => new Date(Date.now() + 14 * 3_600_000).toISOString();

// TOPEST's CDN answers with its own certificate instead of TOPEST's, and HTTP 418 over plain HTTP, and the
// server behind it has no tracker: the site is down, which proves nothing about the adapter.
async function siteDown(): Promise<boolean> {
  let error: unknown = await direct().track({ number: NUMBER }).then(() => undefined, (caught: unknown) => caught);
  for (let depth = 0; error instanceof Error && depth < 6; depth += 1, error = error.cause) {
    if ((error as { code?: unknown }).code === 'ERR_TLS_CERT_ALTNAME_INVALID') return true;
  }
  return false;
}

describe('TOPEST live retrieval', () => {
  it('retrieves the requested number with providers disabled', async (context) => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'topest' }).catch(async (error: unknown) => {
      if (error instanceof TrackingError && error.hint.kind === 'transport' && await siteDown()) return undefined;
      throw error;
    });
    if (!answer) return context.skip('TOPEST\'s site serves its CDN\'s certificate and has no tracker behind it: adapter remains unverified');
    expect(answer).toMatchObject({ carrier: 'topest', source: 'topest' });
    expect(answer.attempts[0]).toMatchObject({ source: 'topest', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time && event.local_time <= latestWallClock())).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TOPEST_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TOPEST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
