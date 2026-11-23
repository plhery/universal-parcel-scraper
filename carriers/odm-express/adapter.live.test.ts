import { describe, expect, it } from 'vitest';
import { OdmTracker } from './adapter.js';

const number = process.env.ODM_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.ODM_EXPRESS_UNKNOWN_NUMBER;

describe('ODM Express live retrieval', () => {
  it.skipIf(!number)('retrieves the dated rows of the requested guide', async () => {
    const result = await new OdmTracker().fetch(number!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events![0]).toMatchObject({ local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
      description: expect.any(String) });
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!unknown)('reads a made-up guide as not found', async () => {
    await expect(new OdmTracker().fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
