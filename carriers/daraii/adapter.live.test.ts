import { describe, expect, it } from 'vitest';
import { DaraiiTracker } from './adapter.js';

const positive = process.env.DARAII_TRACKING_NUMBER;
// An all-zero placeholder, which no order carries.
const unknown = process.env.DARAII_UNKNOWN_NUMBER ?? '000000000000';

describe('daraii live guest retrieval', () => {
  it.skipIf(!positive)('reads an order bound to the whole number', async () => {
    const result = await new DaraiiTracker().fetch(positive!);
    expect(result.status).not.toBe('unknown');
    expect(result.events!.every(event => event.time && event.description)).toBe(true);
  }, 20_000);
  it('reads the empty list for an unknown number as no scan under it', async () => {
    await expect(new DaraiiTracker().fetch(unknown)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 20_000);
});
