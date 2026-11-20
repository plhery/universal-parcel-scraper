import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';
import absent from './fixtures/absent.json' with { type: 'json' };
import archive from './fixtures/archive-history-in-current-schema.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = 'CNB5031548';
const url = `https://firstflightme.com/tracking/awb/${number}`;
const api = 'https://webapi.firstflightme.com/api/user/track-by-awb';

describe('First Flight guest waybill tracking', () => {
  it('captures the response on the requested browser route', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      url, html: '', tier: 3, statusCode: 200,
      capturedResponses: [{ url: api, status: 200, body: JSON.stringify(archive) }],
    }));
    const carrier = adapter({
      trawl: new TrawlClient('https://trawl.invalid'), browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher,
    });
    const result = await carrier.track({ number }, {});
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ url, captureResponses: [api], skipHttp: true });
    expect(result.current_stage).toBe('delivered');
    expect(result.events).toHaveLength(7);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'POD', local_time: '2018-01-11T15:48:00', location: 'Riyadh' });
    expect(result.events?.[4]?.stage).toBe('customs');
  });

  it('identifies only the requested waybill and distinguishes the live negative envelope', () => {
    expect(() => parseTracking(JSON.stringify(absent), 'DUC616804')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(JSON.stringify(archive), number.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(JSON.stringify({ Code: 1 }), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
