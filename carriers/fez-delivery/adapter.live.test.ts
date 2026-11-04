import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.FEZ_DELIVERY_TRACKING_NUMBER;
const unknown = process.env.FEZ_DELIVERY_UNKNOWN_NUMBER;

describe('Fez Delivery live retrieval', () => {
  it.skipIf(!number)('reads the whole reference and its dated history', async () => {
    const result = await direct().track({ number: number! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description && !event.time)).toBe(true);
  });

  it.skipIf(!unknown)('keeps the observed absence response distinct', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
