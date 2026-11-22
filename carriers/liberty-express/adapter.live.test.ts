import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.LIBERTY_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.LIBERTY_EXPRESS_UNKNOWN_NUMBER;

describe('Liberty Express live retrieval', () => {
  it.skipIf(!number)('retrieves the dated history of the requested warehouse receipt', async () => {
    const result = await direct().track({ number: number! });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    // Every row keeps its wall clock, newest first; none is an instant.
    expect(events.every((event) => event.description && !event.time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))
      .toBe(true);
    const clocks = events.map((event) => String(event.local_time));
    expect(clocks).toEqual([...clocks].sort().reverse());
    expect(events.at(-1)).toMatchObject({ stage: 'accepted' });
    expect(result).toMatchObject({ last_update: null, last_update_local: clocks[0], last_status_text: expect.any(String) });
  }, 45_000);

  it.skipIf(!number)('recognizes the requested warehouse receipt', async () => {
    await expect(direct().recognize!(number!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!unknown)('reads a made-up receipt as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
