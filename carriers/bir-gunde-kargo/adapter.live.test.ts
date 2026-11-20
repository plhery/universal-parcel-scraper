import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A parcel still on its way: the page shows only an alert once its round is over.
const number = process.env.BIR_GUNDE_KARGO_TRACKING_NUMBER;

describe('Bir Günde Kargo live tracking', () => {
  it.skipIf(!number)('reads the whole reference and its dated movements', async () => {
    const result = await direct().track({ number: number! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.local_time)).toBe(true);
  }, 30_000);

  it('answers an unissued barcode with the page\'s not-found alert', async () => {
    await expect(direct().track({ number: 'B000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
