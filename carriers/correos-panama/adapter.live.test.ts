import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.CORREOS_PANAMA_TRACKING_NUMBER;
const unknown = process.env.CORREOS_PANAMA_UNKNOWN_NUMBER;

describe('Correos Panamá live retrieval', () => {
  it.skipIf(!number)('retrieves the dated history of the requested item', async () => {
    const result = await direct().track({ number: number! });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    // Panama's scans carry its offset; scans abroad keep their wall clock.
    expect(events.every((event) => event.description && (event.time ? /-05:00$/.test(event.time) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
      .test(String(event.local_time))))).toBe(true);
    expect(events.some((event) => event.time && event.location?.endsWith('Panama'))).toBe(true);
  }, 45_000);

  it.skipIf(!number)('recognizes the requested item', async () => {
    await expect(direct().recognize!(number!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!unknown)('reads a made-up item as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
