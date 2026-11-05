import { describe, expect, it } from 'vitest';
import { ZnlogicTracker } from './adapter.js';

describe('znlogic live retrieval', () => {
  it.skipIf(!process.env.ZNLOGIC_TRACKING_NUMBER)('reads dated guest history', async () => {
    const result = await new ZnlogicTracker().fetch(process.env.ZNLOGIC_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && (event.time || event.local_time))).toBe(true);
  });
  it.skipIf(!process.env.ZNLOGIC_UNKNOWN_NUMBER)('retains the exact absence signature', async () => {
    await expect(new ZnlogicTracker().fetch(process.env.ZNLOGIC_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
