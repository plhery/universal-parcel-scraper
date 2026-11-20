import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseXindus } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');

function tracker(reply: () => Response) {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    urls.push(String(url));
    return reply();
  }) as typeof fetch;
  return { urls, track: adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, fetcher }) };
}

describe('Xindus tracking', () => {
  it('reads a delivered shipment on the clocks Xindus states, with its delivery carrier', () => {
    const result = parseXindus(fixture('delivered-usps'), 'X000570999', 200);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'SHIPMENT_DELIVERED',
      last_status_text: 'Delivered, In/At Mailbox: BELLVILLE, TX, United States',
      last_update: '2025-08-09T12:16:00-05:00', delivered_at: '2025-08-09T12:16:00-05:00',
      delivery_carrier: 'usps', delivery_tracking_number: '9200190369623400025825',
    });
    expect(result.events).toHaveLength(23);
    expect(result.events!.at(-1)).toMatchObject({
      time: '2025-07-28T16:53:42+05:30', description: 'Shipment is ready for pickup', provider_code: 'SHIPMENT_READY_FOR_PICKUP',
      stage: 'registered', stage_source: 'carrier_map',
    });
    expect(result.events!.find((event) => event.provider_code === 'INTRANSIT_002')).toMatchObject({
      time: '2025-08-06T10:52:00-05:00', location: 'ELMHURST, IL, 60126, USA, United States',
    });
    // Staff accounts that wrote a scan are not read.
    expect(JSON.stringify(result)).not.toContain('removed');
  });

  it('orders scans by their instants across the zones they were written in', () => {
    const result = parseXindus(fixture('delivered-uniuni'), 'X000571000', 200);
    expect(result).toMatchObject({ current_stage: 'delivered', delivery_carrier: 'uniuni', delivery_tracking_number: 'UUS57U1058579763478' });
    const times = result.events!.map((event) => Date.parse(event.time!));
    expect(times).toEqual([...times].sort((left, right) => right - left));
    expect(result.events!.map((event) => event.provider_code)).toContain('SHIPMENT_ARRIVED_AT_DESTINATION_COUNTRY');
  });

  it('rejects a reply for another shipment', () => {
    expect(() => parseXindus(fixture('delivered-usps'), 'X000571000', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the explicit unknown-number answer as not found, and no other', () => {
    expect(() => parseXindus(fixture('not-found'), 'X099999991', 500)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = JSON.stringify({ http_status: 500, xindus_error_code: 'IXOS-ERROR', error_status: true, error_description: 'Something went wrong' });
    expect(() => parseXindus(other, 'X099999991', 500)).toThrow(expect.objectContaining({ kind: 'indeterminate', status: 500 }));
    expect(() => parseXindus('{"error_status":false,"data":[]}', 'X099999991', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('never reads a blocked or malformed reply as not found', () => {
    const page = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    expect(() => parseXindus(page, 'X000570999', 200)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseXindus('<html>Server error</html>', 'X000570999', 500)).toThrow(expect.objectContaining({ kind: 'indeterminate', status: 500 }));
    expect(() => parseXindus('<html>Maintenance</html>', 'X000570999', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXindus('{"error_status":false}', 'X000570999', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const zoneless = fixture('delivered-usps').replace('"timezone": "America/Chicago"', '"timezone": null');
    expect(() => parseXindus(zoneless, 'X000570999', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('asks the tracking page\'s lookup for the number and keeps HTTP failures apart from not found', async () => {
    const found = tracker(() => new Response(fixture('delivered-usps'), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(found.track.track({ number: ' x000570999 ' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(found.urls).toEqual(['https://os.xindus.net/ixos-service/oapi/shipment-tracking/shipment?scancode=X000570999']);

    const unknown = tracker(() => new Response(fixture('not-found'), { status: 500 }));
    await expect(unknown.track.track({ number: 'X099999991' })).rejects.toMatchObject({ kind: 'not_found' });
    const limited = tracker(() => new Response('Too many requests', { status: 429 }));
    await expect(limited.track.track({ number: 'X000570999' })).rejects.toMatchObject({ kind: 'rate_limited' });
    const moved = tracker(() => new Response('Not Found', { status: 404 }));
    await expect(moved.track.track({ number: 'X000570999' })).rejects.toMatchObject({ kind: 'transport' });
    await expect(found.track.track({ number: 'X' })).rejects.toMatchObject({ kind: 'invalid_input' });
  });
});
