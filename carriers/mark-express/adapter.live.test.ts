import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.MARK_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.MARK_EXPRESS_UNKNOWN_NUMBER;

describe('Mark Express live retrieval', () => {
  it.skipIf(!number)('retrieves the dated history of the requested air waybill', async () => {
    const result = await direct().track({ number: number! });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    // Every row keeps the office's wall clock or its day, newest first; none is an instant.
    expect(events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/.test(String(event.local_time)))).toBe(true);
    const days = events.map((event) => String(event.local_time).slice(0, 10));
    expect(days).toEqual([...days].sort().reverse());
    expect(events.at(-1)).toMatchObject({ description: expect.stringMatching(/^Booked\b/), stage: 'accepted' });
    expect(result).toMatchObject({ timezone: 'Asia/Kolkata', last_update: null, last_update_local: events[0]!.local_time });
    // The offices' addresses and phone numbers stay out.
    expect(JSON.stringify(result)).not.toMatch(/Ph:|Mobile:|\d{10}/);
  }, 45_000);

  it.skipIf(!number)('recognizes the requested air waybill', async () => {
    await expect(direct().recognize!(number!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!unknown)('reads a made-up number as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
