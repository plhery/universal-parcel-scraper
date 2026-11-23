import { describe, expect, it } from 'vitest';
import { TiuiTracker } from './adapter.js';

const number = process.env.TIUI_TRACKING_NUMBER;
const unknown = process.env.TIUI_UNKNOWN_NUMBER;

describe('Tiui live retrieval', () => {
  it.skipIf(!number)('retrieves the timed movements of the requested folio', async () => {
    const result = await new TiuiTracker().fetch(number!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events![0]).toMatchObject({ time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      provider_code: expect.stringMatching(/^\d+$/), description: expect.any(String) });
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!unknown)('reads a made-up folio as not found', async () => {
    await expect(new TiuiTracker().fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
