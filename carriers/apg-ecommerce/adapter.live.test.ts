import { describe, expect, it } from 'vitest';
import { ApgEcommerceTracker } from './adapter.js';

const number = process.env.APG_ECOMMERCE_TRACKING_NUMBER;
const unknown = process.env.APG_ECOMMERCE_UNKNOWN_NUMBER;
const tracker = new ApgEcommerceTracker();

describe('APG eCommerce live guest history', () => {
  it.skipIf(!number)('reads the public native timeline', async () => {
    const result = await tracker.fetch(number!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time?.endsWith('Z'))).toBe(true);
  });

  it.skipIf(!unknown)('identifies the whole-bound missing reference', async () => {
    await expect(tracker.fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
