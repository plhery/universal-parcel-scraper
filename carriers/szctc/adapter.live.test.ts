import { describe, expect, it } from 'vitest';
import { userAgentOf } from '../../core/transport/index.js';
import { rtb56Entry, rtb56Json } from '../yypost/rtb56.js';
import { SZCTC_CALLBACK, SzctcTracker, szctcLookupUrl } from './adapter.js';
import { PROVIDER } from './parser.js';

// A string outside CTC's layout that no tenant of the platform holds, so it never names a parcel.
const UNKNOWN = process.env.SZCTC_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('CTC Supply Chain live retrieval', () => {
  it.skipIf(!process.env.SZCTC_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new SzctcTracker().fetch(process.env.SZCTC_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // None of the scans is still ahead of the lookup; CTC's own state China's offset.
    expect(result.events!.every((event) => event.description && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
    expect(result.events!.some((event) => event.time?.endsWith('+08:00'))).toBe(true);
  }, 30_000);

  it('reads the tracker’s answer for a number it does not hold as not found', async () => {
    const response = await fetch(szctcLookupUrl(UNKNOWN), { headers: { 'User-Agent': userAgentOf(undefined) } });
    expect(response.status).toBe(200);
    const payload = rtb56Json(await response.text(), SZCTC_CALLBACK, PROVIDER);
    expect(() => rtb56Entry(payload, UNKNOWN, PROVIDER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  }, 30_000);
});
