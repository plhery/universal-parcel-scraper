import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { TrawlClient } from '../../core/transport/trawl.js';

const executablePath = process.env.TRACKING_CHROMIUM_PATH;
// The mobile API is refused here, so the browser answers.
const instance = () => adapter({ browserExecutablePath: executablePath ?? null, trawl: null, recorder: NOOP_RECORDER, env: {},
  fetcher: async () => new Response('', { status: 401 }) });

describe('LBC mobile API live', () => {
  const direct = () => adapter({ browserExecutablePath: null, trawl: null, recorder: NOOP_RECORDER, env: {} });
  it.skipIf(!process.env.LBC_TRACKING_NUMBER)('returns matching history with local scan clocks without a browser', async () => {
    const result = normalizeCarrierResult(await direct().track({ number: process.env.LBC_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time && !event.time)).toBe(true);
    expect(result.last_update).toBeNull();
    expect(result.delivered_at).toBeUndefined();
  });
  it('keeps a synthetic remittance identifier inconclusive for parcel tracking', async () => {
    await expect(direct().track({ number: '199999999977' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

describe('LBC configured browser service live', () => {
  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.LBC_TRACKING_NUMBER)('recovers through a whole-number service capture', async () => {
    const instance = adapter({ browserExecutablePath: null, trawl: TrawlClient.fromEnvironment(), recorder: NOOP_RECORDER, env: {},
      fetcher: (target, init) => String(target).includes('lbcapigateway.lbcapps.com')
        ? Promise.resolve(new Response('', { status: 401 })) : fetch(target, init) });
    const result = await instance.track({ number: process.env.LBC_TRACKING_NUMBER! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time && !event.time)).toBe(true);
  });
});

describe('LBC anonymous browser live', () => {
  it.skipIf(!executablePath || !process.env.LBC_TRACKING_NUMBER)('returns matching history with local scan clocks from the website', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.LBC_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time && !event.time)).toBe(true);
    expect(result.last_update).toBeNull();
    expect(result.delivered_at).toBeUndefined();
  });
  it.skipIf(!executablePath)('keeps a bound but empty synthetic result inconclusive', async () => {
    await expect(instance().track({ number: '199999999977' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
