import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.CARRYBEE_TRACKING_NUMBER;
const unknown = process.env.CARRYBEE_UNKNOWN_NUMBER;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CarryBee live tracking', () => {
  it.skipIf(!number)('reads the consignment bound to the whole number with dated scans', async () => {
    const result = await direct().track({ number: number! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.time?.endsWith('+06:00'))).toBe(true);
  });
  it.skipIf(!unknown)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
