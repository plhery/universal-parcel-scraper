import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.JAMAICA_POST_TRACKING_NUMBER;
const unknown = process.env.JAMAICA_POST_UNKNOWN_NUMBER;

describe('Jamaica Post live retrieval', () => {
  it.skipIf(!number)('retrieves the dated rows of the requested item', async () => {
    const result = await direct().track({ number: number! });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.description && /-05:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!number)('recognizes the requested item', async () => {
    await expect(direct().recognize!(number!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!unknown)('reads a made-up item as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
