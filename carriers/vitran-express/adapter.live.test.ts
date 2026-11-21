import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.VITRAN_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.VITRAN_EXPRESS_UNKNOWN_NUMBER;

describe('Vitran Express live retrieval', () => {
  it.skipIf(!number)('retrieves the summary of the requested PRO bill', async () => {
    const result = await direct().track({ number: number! });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    // Every milestone keeps its day alone, newest first; none is an instant.
    expect(events.every((event) => event.description && !event.time && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    const days = events.map((event) => String(event.local_time));
    expect(days).toEqual([...days].sort().reverse());
    expect(events.at(-1)).toMatchObject({ description: 'Picked Up', stage: 'accepted' });
    expect(result).toMatchObject({ summary_only: true, last_update: null, last_update_local: events[0]!.local_time });
    expect(result.last_status_text).toBeTruthy();
  }, 45_000);

  it.skipIf(!number)('recognizes the requested PRO bill', async () => {
    await expect(direct().recognize!(number!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!unknown)('reads a made-up number as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
