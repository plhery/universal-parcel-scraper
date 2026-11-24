import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const tracker = () => createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL });

describe('HIT Cargo live retrieval', () => {
  it.skipIf(!process.env.HIT_CARGO_NICARAGUA_TRACKING_NUMBER || !process.env.FLARESOLVERR_URL)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await tracker().track({ number: process.env.HIT_CARGO_NICARAGUA_TRACKING_NUMBER!, carrier: 'hit-cargo-nicaragua' });
    expect(answer).toMatchObject({ carrier: 'hit-cargo-nicaragua', source: 'hit-cargo-nicaragua' });
    expect(answer.attempts[0]).toMatchObject({ source: 'hit-cargo-nicaragua', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event has its wording and either a wall clock or an instant.
    expect(answer.result.events.every(event => event.description && (event.time || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))).toBe(true);
  }, 90_000);

  it.skipIf(!process.env.HIT_CARGO_NICARAGUA_UNKNOWN_NUMBER || !process.env.FLARESOLVERR_URL)('reads an unknown number as not found', async () => {
    const answer = await tracker().track({ number: process.env.HIT_CARGO_NICARAGUA_UNKNOWN_NUMBER!, carrier: 'hit-cargo-nicaragua' });
    expect(answer.attempts[0]).toMatchObject({ source: 'hit-cargo-nicaragua', kind: 'not_found' });
  }, 90_000);

  it.skipIf(!process.env.HIT_CARGO_NICARAGUA_TRACKING_NUMBER)('meets Cloudflare’s check or the reply without the browser service', async () => {
    const direct = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    const answer = await direct.track({ number: process.env.HIT_CARGO_NICARAGUA_TRACKING_NUMBER! }).catch((error: unknown) => error);
    expect(answer).toSatisfy(value => (value as { kind?: string }).kind === 'challenge' || Array.isArray((value as { events?: unknown }).events));
  }, 30_000);
});
