import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, DaoTracker } from './adapter.js';

const trawl = TrawlClient.fromEnvironment();

describe('DAO live direct retrieval', () => {
  it.skipIf(!process.env.DAO_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new DaoTracker({ trawl }).fetch(process.env.DAO_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && /^(?:[A-Za-z]+\/)?\d+$/.test(event.provider_code ?? ''))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
    expect(result.last_update).toBeNull();
  }, 100_000);
  it.skipIf(!process.env.DAO_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new DaoTracker({ trawl }).fetch(process.env.DAO_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 100_000);
  it.skipIf(!trawl || !process.env.DAO_TRACKING_NUMBER)('confirms the parcel through the tracking page in browser recognition', async () => {
    const instance = adapter({ recorder: NOOP_RECORDER, env: {}, trawl, browserExecutablePath: null });
    await expect(instance.recognizeWithBrowser!(process.env.DAO_TRACKING_NUMBER!, { budgetMs: 20_000 }))
      .resolves.toMatchObject({ known: true, lastActivityLocal: expect.any(String) });
  }, 30_000);
});
