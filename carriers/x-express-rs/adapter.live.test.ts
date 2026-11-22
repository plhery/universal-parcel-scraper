import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracking page's example, unless another shipment number is given.
const NUMBER = process.env.X_EXPRESS_RS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('X Express Serbia live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'x-express-rs' });
    expect(answer).toMatchObject({ carrier: 'x-express-rs', source: 'x-express-rs' });
    expect(answer.attempts[0]).toMatchObject({ source: 'x-express-rs', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Scans to the minute on Belgrade's wall clock, none in the future; an instant beside one is
    // deduced from Serbia's zone.
    expect(events.every((event) => event.description && (!event.time || event.time_zone === 'Europe/Belgrade')
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)) && String(event.local_time) <= new Date().toISOString())).toBe(true);
    expect(events.at(-1)!.stage).toBeDefined();
  }, 45_000);

  it.skipIf(!process.env.X_EXPRESS_RS_UNKNOWN_NUMBER)('reads an unknown shipment as not found', async () => {
    await expect(direct().track({ number: process.env.X_EXPRESS_RS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
