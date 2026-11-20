import { describe, expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import sample from './fixtures/sample.json' with { type: 'json' };
import { normalizeNumber, parseTracking } from './parser.js';

const number = sample.trackingNumber;

describe('Sway tracking', () => {
  it('restores the case required by the guest API and reads its dated states', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(sample));
    const result = await adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher })
      .track({ number: directTrackingNumber('sway', number) }, {});
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://track.shipsway.com/api/tracking/${number}`);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2023-12-15T22:24:18Z' });
    expect(result.events?.map(event => event.provider_code)).toEqual(['DELIVERED', 'IN_TRANSIT', 'RECEIVED', 'PENDING']);
    expect(normalizeNumber('swy123456789')).toBe('SWY-123456789');
  });

  it('keeps a shipment miss, an API miss, a browser wall, and another identity distinct', () => {
    expect(() => parseTracking(404, 'null', number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(404, '<html>Gone</html>', number)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTracking(200, '<title>Just a moment</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTracking(200, JSON.stringify(sample), number.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(200, JSON.stringify({ ...sample, destinationCountry: 'CA' }), number))
      .toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});
