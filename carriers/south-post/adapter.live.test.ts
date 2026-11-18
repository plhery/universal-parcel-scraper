import { describe, expect, it } from 'vitest';
import { SouthPostTracker } from './adapter.js';

const positive = process.env.SOUTH_POST_TRACKING_NUMBER;
const unknown = process.env.SOUTH_POST_UNKNOWN_NUMBER;

describe('south-post live guest retrieval', () => {
  it.skipIf(!positive)('reads a shipment bound to the whole number', async () => {
    const result = await new SouthPostTracker().fetch(positive!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time && event.description)).toBe(true);
  }, 20_000);
  // The tracker answers an unknown number with HTTP 500, which stays a failure.
  it.skipIf(!unknown)('keeps an unknown number\'s error as a failure', async () => {
    await expect(new SouthPostTracker().fetch(unknown!)).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 20_000);
});
