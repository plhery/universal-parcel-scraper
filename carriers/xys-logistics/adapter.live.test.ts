import { describe, expect, it } from 'vitest';
import { userAgentOf } from '../../core/transport/index.js';
import { rtb56Entry, rtb56Json } from '../yypost/rtb56.js';
import { XYS_CALLBACK, XysTracker, xysLookupUrl } from './adapter.js';
import { PROVIDER } from './parser.js';

// A string outside XYS Logistics's layout that no tenant of the platform holds, so it never names a parcel.
const UNKNOWN = process.env.XYS_LOGISTICS_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('XYS Logistics live retrieval', () => {
  it.skipIf(!process.env.XYS_LOGISTICS_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new XysTracker().fetch(process.env.XYS_LOGISTICS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan keeps the wall clock the tracker gives it.
    expect(result.events!.every((event) => event.description && event.local_time && !event.time)).toBe(true);
  }, 30_000);

  it('reads the tracker’s answer for a number it does not hold as not found', async () => {
    const response = await fetch(xysLookupUrl(UNKNOWN), { headers: { 'User-Agent': userAgentOf(undefined) } });
    expect(response.status).toBe(200);
    const payload = rtb56Json(await response.text(), XYS_CALLBACK, PROVIDER);
    expect(() => rtb56Entry(payload, UNKNOWN, PROVIDER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  }, 30_000);
});
