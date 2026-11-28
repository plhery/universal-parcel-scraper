import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const positive = process.env.HART2HART_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.HART2HART_EXPRESS_UNKNOWN_NUMBER;
const carrier = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('hart2hart-express live guest retrieval', () => {
  it.skipIf(!positive)('reads a job bound to the whole number', async () => {
    const result = await carrier().track({ number: positive! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.local_time && event.description)).toBe(true);
  }, 20_000);
  it.skipIf(!unknown)('reports an unknown number as not found', async () => {
    await expect(carrier().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 20_000);
});
