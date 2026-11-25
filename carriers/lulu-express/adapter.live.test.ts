import { describe, expect, it } from 'vitest';
import { userAgentOf } from '../../core/transport/index.js';
import { rtb56Entry, rtb56Json } from '../yypost/rtb56.js';
import { LULU_EXPRESS_CALLBACK, LuluExpressTracker, luluExpressLookupUrl } from './adapter.js';
import { PROVIDER } from './parser.js';

// A string outside luluExpress's layout that no tenant of the platform holds, so it never names a parcel.
const UNKNOWN = process.env.LULU_EXPRESS_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('luluExpress live retrieval', () => {
  it.skipIf(!process.env.LULU_EXPRESS_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new LuluExpressTracker().fetch(process.env.LULU_EXPRESS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // None of the scans is still ahead of the lookup; luluExpress's own state China's offset.
    expect(result.events!.every((event) => event.description && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
    expect(result.events!.some((event) => event.time?.endsWith('+08:00'))).toBe(true);
  }, 30_000);

  it('reads the tracker’s answer for a number it does not hold as not found', async () => {
    const response = await fetch(luluExpressLookupUrl(UNKNOWN), { headers: { 'User-Agent': userAgentOf(undefined) } });
    expect(response.status).toBe(200);
    const payload = rtb56Json(await response.text(), LULU_EXPRESS_CALLBACK, PROVIDER);
    expect(() => rtb56Entry(payload, UNKNOWN, PROVIDER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  }, 30_000);
});
