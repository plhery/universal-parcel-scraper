import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.TP_LOGISTICS_TH_TRACKING_NUMBER;
const unknown = process.env.TP_LOGISTICS_TH_UNKNOWN_NUMBER;

describe('TP Logistics live retrieval', () => {
  it.skipIf(!number)('retrieves the dated history of the requested parcel', async () => {
    const result = await direct().track({ number: number! }, { budgetMs: 30_000 });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    // Every scan keeps the branch's wall clock, newest first; none is an instant.
    expect(events.every((event) => event.description && !('time' in event)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    const clocks = events.map((event) => String(event.local_time));
    expect(clocks).toEqual([...clocks].sort().reverse());
    expect(events.at(-1)).toMatchObject({ stage: 'accepted', stage_source: 'carrier_map' });
    expect(result).toMatchObject({ timezone: 'Asia/Bangkok', last_update: null, last_update_local: clocks[0] });
    expect(result.last_status_text).toBeTruthy();
  }, 45_000);

  it.skipIf(!number)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(number!, { budgetMs: 30_000 })).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!unknown)('reads a made-up number as not found', async () => {
    await expect(direct().track({ number: unknown! }, { budgetMs: 30_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
