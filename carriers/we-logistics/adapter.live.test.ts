import { describe, expect, it } from 'vitest';
import { userAgentOf } from '../../core/transport/index.js';
import { rtb56Entry, rtb56Json } from '../yypost/rtb56.js';
import { WE_LOGISTICS_CALLBACK, WeLogisticsTracker, weLogisticsLookupUrl } from './adapter.js';
import { PROVIDER } from './parser.js';

// A string outside WE Logistics's layout that no tenant of the platform holds, so it never names a parcel.
const UNKNOWN = process.env.WE_LOGISTICS_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('WE Logistics live retrieval', () => {
  it.skipIf(!process.env.WE_LOGISTICS_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new WeLogisticsTracker().fetch(process.env.WE_LOGISTICS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan has wording, and an instant only where it states its offset.
    expect(result.events!.every((event) => event.description && (event.time ? /[+-]\d{2}:\d{2}$/.test(event.time) : event.local_time))).toBe(true);
  }, 30_000);

  it('reads the tracker’s answer for a number it does not hold as not found', async () => {
    const response = await fetch(weLogisticsLookupUrl(UNKNOWN), { headers: { 'User-Agent': userAgentOf(undefined) } });
    expect(response.status).toBe(200);
    const payload = rtb56Json(await response.text(), WE_LOGISTICS_CALLBACK, PROVIDER);
    expect(() => rtb56Entry(payload, UNKNOWN, PROVIDER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  }, 30_000);
});
