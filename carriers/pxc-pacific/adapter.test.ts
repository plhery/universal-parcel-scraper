import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parsePxc } from './parser.js';
import { pxcStage } from './status.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');

function tracker(reply: () => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return reply();
  }) as typeof fetch;
  return { requests, track: adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, fetcher }) };
}

describe('PXC Pacific Global tracking', () => {
  it('reads a parcel delivered in New Zealand by DTDC Australia, on its wall clocks', () => {
    const result = parsePxc(fixture('delivered-new-zealand'), '8889999990', 200);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'OK',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2025-10-06T09:01:00', destination_country: 'NZ',
      // DTDC Australia is no catalog carrier: its number is handed on alone.
      delivery_tracking_number: '599999999901',
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events).toHaveLength(27);
    // PXC's delivery and the partner's round at the same minute keep the reply's order.
    expect(result.events!.slice(0, 3).map((event) => [event.provider_code, event.stage])).toEqual([
      ['OK', 'delivered'], ['15', 'out_for_delivery'], ['124', 'exception'],
    ]);
    expect(result.events![2]).toMatchObject({ description: 'On Hold - In Branch', location: 'Auckland - NEW ZEALAND' });
    expect(result.events!.at(-1)).toMatchObject({
      local_time: '2025-09-17T16:33:00', location: 'MUMBAI', description: 'SHIPMENT INFORMATION RECEIVED',
      provider_code: '01', stage: 'registered', stage_source: 'carrier_map',
    });
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    const clocks = result.events!.map((event) => event.local_time as string);
    expect(clocks).toEqual([...clocks].sort().reverse());
    // The receiver and consignee names are never read.
    expect(JSON.stringify(result)).not.toContain('EXAMPLE');
  });

  it('reads a parcel held by customs and hands it to a partner the page links', () => {
    const result = parsePxc(fixture('customs-australia'), '8889999991', 200);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'customs', provider_code: '10', last_update_local: '2025-10-18T19:04:00',
      destination_country: 'AU', delivery_carrier: 'australia-post', delivery_tracking_number: '599999999902',
    });
    // The onward flight PXC books at its transit point, and a code-less step, by their recorded wording.
    expect(result.events!.find((event) => event.description?.startsWith('SHIPMENT PLANNED FROM TRANSIT POINT')))
      .toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map', location: 'KUALA LUMPUR,MALAYSIA' });
    expect(result.events!.find((event) => event.description === 'SHIPMENT PROCESSED AT EXPORT GATEWAY'))
      .not.toHaveProperty('provider_code');
    expect(result.events!.find((event) => event.provider_code === 'SH')).toMatchObject({ stage: 'accepted' });
    // A wording not recorded for a code that has one stage keeps the code's stage.
    expect(pxcStage('15', 'Out for Delivery - Second Attempt')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(pxcStage('', 'Synthetic unknown step')?.source).not.toBe('carrier_map');
  });

  it('rejects a reply for another number', () => {
    expect(() => parsePxc(fixture('delivered-new-zealand'), '8889999991', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the lookup\'s "AWB does not exist" as not found, and no other refusal', () => {
    expect(() => parsePxc(fixture('not-found'), '8889999992', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const page = JSON.stringify({ Response: { ResponseCode: 'TD01', ErrorCode: '1', ErrorDisc: 'AWB No not found', Tracking: null, Events: null } });
    expect(() => parsePxc(page, '8889999992', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const refused = JSON.stringify({ Response: { ResponseCode: 'TD02', ErrorCode: '1', ErrorDisc: 'Invalid User', Tracking: null, Events: null } });
    expect(() => parsePxc(refused, '8889999992', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePxc('{"Response":null}', '8889999992', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a listed shipment without scans as having no history, with its partner\'s number', () => {
    const reply = JSON.parse(fixture('delivered-new-zealand')) as { Response: { Events: unknown[] } };
    reply.Response.Events = [];
    expect(() => parsePxc(JSON.stringify(reply), '8889999990', 200)).toThrow(expect.objectContaining({
      kind: 'indeterminate', reason: 'listed', deliveryTrackingNumber: '599999999901',
    }));
  });

  it('never reads a blocked or malformed reply as not found', () => {
    const page = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    expect(() => parsePxc(page, '8889999990', 200)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parsePxc('<html>Server Error</html>', '8889999990', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePxc('<html>Bad gateway</html>', '8889999990', 502)).toThrow(expect.objectContaining({ kind: 'indeterminate', status: 502 }));
    const timeless = fixture('delivered-new-zealand').replace('"EventTime": "0901"', '"EventTime": "9:01"');
    expect(() => parsePxc(timeless, '8889999990', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const midnight = fixture('delivered-new-zealand').replace('"EventTime": "0901"', '"EventTime": "2400"');
    expect(() => parsePxc(midnight, '8889999990', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('posts the number with the page\'s visitor login and keeps HTTP failures apart from not found', async () => {
    const json = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
    const found = tracker(json(fixture('delivered-new-zealand')));
    await expect(found.track.track({ number: ' 8889-999990 ' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(found.requests).toHaveLength(1);
    expect(found.requests[0]).toMatchObject({ url: 'https://eship.pacificexp.net/api/v1/Tracking/Tracking', init: { method: 'POST' } });
    expect(JSON.parse(String(found.requests[0]!.init.body))).toMatchObject({ AWBNo: '8889999990', Type: 'A', RequiredUrl: 'yes', UserID: 'test1' });

    const unknown = tracker(json(fixture('not-found')));
    await expect(unknown.track.track({ number: '8889999992' })).rejects.toMatchObject({ kind: 'not_found' });
    const limited = tracker(() => new Response('Too many requests', { status: 429 }));
    await expect(limited.track.track({ number: '8889999990' })).rejects.toMatchObject({ kind: 'rate_limited' });
    const refused = tracker(() => new Response('<html>Forbidden</html>', { status: 403 }));
    await expect(refused.track.track({ number: '8889999990' })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = tracker(() => new Response('<html>Not Found</html>', { status: 404 }));
    await expect(moved.track.track({ number: '8889999990' })).rejects.toMatchObject({ kind: 'transport' });
    await expect(found.track.track({ number: '8880' })).rejects.toMatchObject({ kind: 'invalid_input' });
  });
});
