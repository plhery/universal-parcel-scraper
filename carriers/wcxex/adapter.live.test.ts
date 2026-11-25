import { describe, expect, it } from 'vitest';
import { userAgentOf } from '../../core/transport/index.js';
import { rtb56Entry, rtb56Json } from '../yypost/rtb56.js';
import { WCXEX_CALLBACK, WcxexTracker, wcxexLookupUrl } from './adapter.js';
import { PROVIDER } from './parser.js';

// A string outside WCXEX's layout that no tenant of the platform holds, so it never names a parcel.
const UNKNOWN = process.env.WCXEX_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('WCXEX live retrieval', () => {
  it.skipIf(!process.env.WCXEX_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new WcxexTracker().fetch(process.env.WCXEX_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan has wording, and an instant only where it states its offset.
    expect(result.events!.every((event) => event.description && (event.time ? /[+-]\d{2}:\d{2}$/.test(event.time) : event.local_time))).toBe(true);
  }, 30_000);

  it('reads the tracker’s answer for a number it does not hold as not found', async () => {
    const response = await fetch(wcxexLookupUrl(UNKNOWN), { headers: { 'User-Agent': userAgentOf(undefined) } });
    expect(response.status).toBe(200);
    const payload = rtb56Json(await response.text(), WCXEX_CALLBACK, PROVIDER);
    expect(() => rtb56Entry(payload, UNKNOWN, PROVIDER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  }, 30_000);
});
