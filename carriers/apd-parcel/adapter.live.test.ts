import { describe, expect, it } from 'vitest';
import { ApdTracker } from './adapter.js';

const positive = process.env.APD_TRACKING_NUMBER;
const unknown = process.env.APD_UNKNOWN_NUMBER;

describe('apd-parcel live guest retrieval', () => {
  it.skipIf(!positive)('reads a label bound to the whole number', async () => {
    const result = await new ApdTracker().fetch(positive!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time && event.description && event.provider_code)).toBe(true);
  }, 20_000);
  it.skipIf(!unknown)('reports an unknown label as not found', async () => {
    await expect(new ApdTracker().fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 20_000);
});
