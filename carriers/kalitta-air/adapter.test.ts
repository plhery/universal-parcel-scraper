import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeKalittaAirNumber, parseKalittaAirTracking } from './parser.js';
import { statusMap } from './status.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const cleared = fixture('cleared.html');
const manifested = fixture('manifested.html');
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Kalitta Air air waybills', () => {
  it('takes the 272 prefix with or without separators, or the serial alone, and checks the last digit', () => {
    expect(normalizeKalittaAirNumber('272-73364034')).toBe('27273364034');
    expect(normalizeKalittaAirNumber('272 7336 4034')).toBe('27273364034');
    expect(normalizeKalittaAirNumber('27273364034')).toBe('27273364034');
    expect(normalizeKalittaAirNumber('73364034')).toBe('27273364034');
    expect(() => normalizeKalittaAirNumber('272-73364035')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeKalittaAirNumber('180-73364034')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // The example on the tracker's form fails the check.
    expect(() => normalizeKalittaAirNumber('272-12345678')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('posts the tracker form with the waybill and asks for its own messages in UTC', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(cleared));
    const result = await tracker(fetcher).track({ number: '27273364034' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://kalitta-cnm.com/tracktrace/default.aspx');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('cookie')).toBe('usertz=UTC');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ txtAWB: '272-73364034', action: 'SearchAWB' });
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', provider_code: 'cargocleared',
      last_status_text: 'Consignment has been cleared by customs at JFK on 10MAY, 19:41 (45 pieces)',
      last_update: null, last_update_local: '2023-05-10T19:41',
    });
  });

  it('keeps each station’s wall clock and place in the tracker’s order', () => {
    const { events = [] } = parseKalittaAirTracking(cleared, '27273364034');
    expect(events).toHaveLength(9);
    expect(events[0]).toMatchObject({ provider_code: 'cargocleared', location: 'JFK', local_time: '2023-05-10T19:41', stage: 'in_transit' });
    expect(events[1]).toMatchObject({ provider_code: 'customs', description: 'CLEARED, 45 pieces, on 05/10/2023 7:41:00 PM', stage: 'in_transit' });
    expect(events[1]).not.toHaveProperty('location');
    expect(events.find(event => event.description?.startsWith('TRANSFER AUTHORIZED'))).toMatchObject({ provider_code: 'customs', stage: 'customs' });
    expect(events.find(event => event.provider_code === 'arrived')).toMatchObject({
      description: '45 packages, 985K received from flight K4923 at JFK on 10MAY2023 14:16:00 (45 pieces)',
      location: 'JFK', local_time: '2023-05-10T14:16', stage: 'in_transit',
    });
    expect(events.find(event => event.provider_code === 'consignmentcustoms')).toMatchObject({ location: 'JFK', local_time: '2023-05-10T00:30', stage: 'customs' });
    // Documents handed over at Anchorage, the transfer airport, before the flight on to New York.
    expect(events.at(-1)).toMatchObject({ provider_code: 'awbdelivered', location: 'ANC', local_time: '2023-05-09T00:29', stage: 'in_transit' });
    expect(events.some(event => event.time)).toBe(false);
  });

  it('reads the times the tracker converts as UTC instants and keeps them where it lists them', () => {
    const { events = [] } = parseKalittaAirTracking(manifested, '27272491112');
    const manifest = events.findIndex(event => event.provider_code === 'manifested');
    expect(events[manifest]).toEqual({
      description: 'Manifested 3 packages, 20.00K on flight K4925, TAO-ICN', time: '2023-09-15T02:04:00Z',
      provider_code: 'manifested', location: 'TAO', stage: 'in_transit', stage_source: 'carrier_map',
    });
    expect(events[manifest - 1]).toMatchObject({ provider_code: 'consignmentcustoms', local_time: '2023-09-15T02:46' });
    expect(events[manifest + 1]).toMatchObject({ provider_code: 'customs', local_time: '2023-09-14T22:50' });
  });

  it('leaves the freight for collection when the documents are delivered at the waybill’s destination', () => {
    const atAnchorage = cleared.replace('<div class="fn">Destination</div><div class="fv">JFK</div>', '<div class="fn">Destination</div><div class="fv">ANC</div>');
    expect(parseKalittaAirTracking(atAnchorage, '27273364034').events?.at(-1)).toMatchObject({ provider_code: 'awbdelivered', stage: 'ready_for_pickup' });
    expect(statusMap.stage('awbdelivered', 'documentation delivered to a b at anc on 09may, 00:29 (3 pieces)')).toBeUndefined();
    expect(statusMap.stage('customs', 'cleared, 45 pieces, on 05/10/2023 7:41:00 pm')).toBe('in_transit');
    expect(statusMap.stage('consignmentcustoms', 'consignment has been reported to customs at jfk on 10may, 00:30 (45 pieces)')).toBe('customs');
  });

  it('requires the requested waybill and the clocks it asked for', () => {
    expect(() => parseKalittaAirTracking(cleared, '27272491112')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const european = manifested.replaceAll('Timezone: Coordinated Universal Time', 'Timezone: Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna');
    expect(() => parseKalittaAirTracking(european, '27272491112')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('tells a listed waybill without statuses from a missing one', async () => {
    const listed = cleared.replace(/<div id=TTPanel-\d+ class="TTPanel "><div class="TTPanel-header"><div class="TTPanel-header-title">Status updates.*?<\/table><\/div><\/div>/s, '');
    expect(listed).not.toContain('Status updates');
    expect(() => parseKalittaAirTracking(listed, '27273364034')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    // The tracker's answer for the example on its form, with the waybill it searched.
    const notFound = fixture('not-found.html').replaceAll('272-12345678', '272-73364034');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(notFound));
    await expect(tracker(fetcher).track({ number: '272-73364034' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not take a verification page or an empty form for a missing waybill', async () => {
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(html('<html><head><title>Access Denied</title></head></html>', 403));
    await expect(tracker(challenged).track({ number: '272-73364034' })).rejects.toMatchObject({ kind: 'challenge' });
    const verifying = vi.fn<typeof fetch>().mockResolvedValueOnce(html('<html><head><title>Just a moment...</title></head></html>'));
    await expect(tracker(verifying).track({ number: '272-73364034' })).rejects.toMatchObject({ kind: 'challenge' });
    const form = cleared.slice(0, cleared.indexOf('<div class="awb-cols">'));
    const empty = vi.fn<typeof fetch>().mockResolvedValueOnce(html(form));
    await expect(tracker(empty).track({ number: '272-73364034' })).rejects.toMatchObject({ kind: 'schema' });
  });
});
