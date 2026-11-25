import { describe, expect, it } from 'vitest';
import { userAgentOf } from '../../core/transport/index.js';
import { rtb56Entry, rtb56Json } from '../yypost/rtb56.js';
import { KEKE_CALLBACK, KekeTracker, kekeLookupUrl } from './adapter.js';
import { PROVIDER } from './parser.js';

// A string no tenant of the platform holds, so it never names a parcel.
const UNKNOWN = process.env.KEKE_INTERNATIONAL_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('Keke International live retrieval', () => {
  it.skipIf(!process.env.KEKE_INTERNATIONAL_TRACKING_NUMBER)('retrieves the parcel’s history', async () => {
    const result = await new KekeTracker().fetch(process.env.KEKE_INTERNATIONAL_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan keeps the wall clock the tracker gives it.
    expect(result.events!.every((event) => event.description && event.local_time && !event.time)).toBe(true);
  }, 30_000);

  it('reads the tracker’s answer for a number it does not hold as not found', async () => {
    const response = await fetch(kekeLookupUrl(UNKNOWN), { headers: { 'User-Agent': userAgentOf(undefined) } });
    expect(response.status).toBe(200);
    const payload = rtb56Json(await response.text(), KEKE_CALLBACK, PROVIDER);
    expect(() => rtb56Entry(payload, UNKNOWN, PROVIDER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  }, 30_000);
});
