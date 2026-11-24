import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.INPOSDOM_TRACKING_NUMBER;
const unknown = process.env.INPOSDOM_UNKNOWN_NUMBER;

describe('INPOSDOM live retrieval', () => {
  it.skipIf(!number)('retrieves the status and entry day of the requested item', async () => {
    const result = await direct().track({ number: number! });
    expect(result).toMatchObject({ destination_country: 'DO', summary_only: true, last_status_text: expect.any(String) });
    expect(result.events!.every((event) => /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)) && event.time === undefined)).toBe(true);
  }, 45_000);

  it.skipIf(!unknown)('reads an item that has not entered the country as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
