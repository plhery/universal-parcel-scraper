import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.UOF_TRACKING_NUMBER;

describe('UOF International live tracking', () => {
  it.skipIf(!number)('gets dated events from UOF International', async () => {
    const tracker = createTracker({ providers: [] });
    const reply = await tracker.track({ number: number!, carrier: 'uof-express' });
    expect(reply).toMatchObject({ carrier: 'uof-express', source: 'uof-express' });
    expect(reply.result.events.length).toBeGreaterThan(0);
    expect(reply.result.events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 30_000);
});
