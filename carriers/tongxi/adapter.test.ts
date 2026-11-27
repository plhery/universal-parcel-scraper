import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseHualeiPage, parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter, TongxiTracker } from './adapter.js';
import { splitTongxiRow, TONGXI, TONGXI_ORIGIN, tongxiClock } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, which `delivered.json` answers, and a made-up number the tracker does not know.
const NUMBER = 'TX0000000100442089';
const UNKNOWN = 'TX0000000000000017';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-27T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const unknownPage = () => readFileSync(new URL('../gzyl/fixtures/page-unknown.html', import.meta.url), 'utf8').replaceAll('NOTFOUND000001', UNKNOWN);
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (content: string, location = '') => ({ clock: '2026-10-26 08:53:44', content, location, code: '' });

describe('TongXi numbers', () => {
  it('takes the forwarder’s names', () => {
    for (const name of ['TongXi', 'Tongxi Supply Chain', '桐溪供应链', '深圳市桐溪供应链管理有限公司']) expect(carrierIdFromName(name), name).toBe('tongxi');
  });

  it('offers its TX numbers whole for the tracker to confirm, and reads a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['tongxi'] });
    for (const number of [NUMBER.slice(0, -1), `${NUMBER}0`, `TY${NUMBER.slice(2)}`]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('tongxi');
    }
    expect(parseTrackingInput(`http://1.14.133.93:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'tongxi' });
  });
});

describe('TongXi tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new TongxiTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER.toLowerCase()} `))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'ES' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TONGXI_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(TONGXI_ORIGIN).toBe('http://1.14.133.93:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'tongxi', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads a parcel delivered in Spain, the line’s rows on Beijing’s clock and the delivery carrier’s on its wall clock', () => {
    const result = parseHualeiTrack(fixture('delivered'), NUMBER, TONGXI, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Success Your shipment has been delivered successfully',
      last_update: null, last_update_local: '2026-10-26T15:45:21', service_name: 'Europe Line Battery(Duties Paid)', destination_country: 'ES',
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('canonical_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(20);
    expect(events.every((event) => event.stage && event.stage_source === 'carrier_map')).toBe(true);
    const at = (description: string) => events.filter((event) => event.description === description).map((event) => event.time ?? event.local_time);
    expect(at('Delivery Attempt Failure Your shipment delivery attempt failed [Recipient not at home]')).toEqual(['2026-10-26T11:40:18']);
    expect(at('Out for Delivery Your shipment is out for delivery')).toEqual(['2026-10-26T08:53:44', '2026-10-25T10:33:01']);
    expect(at('Sorting Center Inbound Your shipment has arrived at sorting center')).toEqual(['2026-10-24T13:57:41']);
    expect(at('Parcel in transit')).toHaveLength(4);
    expect(at('Parcel in transit').every((time) => time?.endsWith('+08:00'))).toBe(true);
    // Read on Madrid's clock, the platform would have written these rows before they happened.
    expect(at('Arrived at airport of the original country')).toEqual(['2026-10-10T13:11:19+08:00']);
    expect(at('Departed from the first mile sorting center')).toEqual(['2026-10-09T04:07:11+08:00']);
    expect(events.find((event) => event.description === 'Departed from customs')).toEqual(expect.objectContaining({
      time: '2026-10-14T08:27:30+08:00', stage: 'in_transit',
    }));
    // The destination country the line writes as a place, even at the origin airport, is left out.
    expect(events.some((event) => event.location?.includes('Spain'))).toBe(false);
    expect(events.at(-2)).toMatchObject({
      time: '2026-10-06T19:13:27+08:00', description: 'Shipment arrvied at TX origin facility', location: 'DONGGUAN', provider_code: 'ARRIVAL', stage: 'accepted',
    });
    expect(events.at(-1)).toMatchObject({ time: '2026-10-03T11:03:04+08:00', description: 'Parcel Data Received', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/signperson|customer_code|TX0640/i);
  });

  it('finds the parcel by the shipper’s reference and gives its own number', () => {
    expect(parseHualeiTrack(fixture('delivered'), 'XM7EJ1513294', TONGXI, READ_AT)).toMatchObject({ canonical_tracking_number: NUMBER });
  });

  it('reads a row’s clock and place by whose row it is', () => {
    expect(tongxiClock(row('Out for Delivery Your shipment is out for delivery'))).toBe('wall');
    expect(tongxiClock(row('Parcel in transit'))).toBe('platform');
    expect(tongxiClock(row('Departed from customs of', 'Spain,ESP'))).toBe('platform');
    expect(splitTongxiRow('Departed from customs of', 'Spain,ESP')).toEqual({ content: 'Departed from customs', location: '' });
    expect(splitTongxiRow('Arrived at destination airport', 'ESP')).toEqual({ content: 'Arrived at destination airport', location: '' });
    expect(splitTongxiRow('Shipment departed from sort facility', 'DONGGUAN')).toEqual({ content: 'Shipment departed from sort facility', location: 'DONGGUAN' });
    expect(splitTongxiRow('Sorting Center Inbound Your shipment has arrived at sorting center', 'Spain'))
      .toEqual({ content: 'Sorting Center Inbound Your shipment has arrived at sorting center', location: 'Spain' });
  });

  it('settles the interface’s no-row answer with the page, which reads an unknown number as not found', async () => {
    expect(parseHualeiTrack(fixture('no-track'), UNKNOWN, TONGXI, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(unknownPage()));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${TONGXI_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHualeiPage(unknownPage(), UNKNOWN, TONGXI, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(unknownPage()));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TX', `${NUMBER},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error, another parcel as inconclusive and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'true', data: {} }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered'))))).track({ number: 'TX9999999999999999' }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'tongxi', description: 'Delivery Attempt Failure Your shipment delivery attempt failed [Address incorrect]' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'tongxi', description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });
});
