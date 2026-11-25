import { describe, expect, it } from 'vitest';
import { userAgentOf } from '../../core/transport/index.js';
import { rtb56Entry, rtb56Json } from '../yypost/rtb56.js';
import { HUAYUTONG_CALLBACK, HuayutongTracker, huayutongLookupUrl } from './adapter.js';
import { PROVIDER } from './parser.js';

// A string outside Huayutong's layout that no tenant of the platform holds, so it never names a parcel.
const UNKNOWN = process.env.HUAYUTONG_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('Huayutong live retrieval', () => {
  it.skipIf(!process.env.HUAYUTONG_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new HuayutongTracker().fetch(process.env.HUAYUTONG_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan keeps the wall clock the tracker gives it.
    expect(result.events!.every((event) => event.description && event.local_time && !event.time)).toBe(true);
  }, 30_000);

  it('reads the tracker’s answer for a number it does not hold as not found', async () => {
    const response = await fetch(huayutongLookupUrl(UNKNOWN), { headers: { 'User-Agent': userAgentOf(undefined) } });
    expect(response.status).toBe(200);
    const payload = rtb56Json(await response.text(), HUAYUTONG_CALLBACK, PROVIDER);
    expect(() => rtb56Entry(payload, UNKNOWN, PROVIDER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  }, 30_000);
});
