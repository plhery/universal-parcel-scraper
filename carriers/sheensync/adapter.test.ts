import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SheensyncTracker, sheensyncLookupUrl, SHEENSYNC_API, SHEENSYNC_PAGE } from './adapter.js';
import { normalizeSheensyncNumber, parseSheensync } from './parser.js';
import { sheensyncStage, statusMap } from './status.js';

const NUMBER = 'SS202600000371';
const UNKNOWN = 'SS000000000000';
const fixture = (name: 'delivered' | 'not-found') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

describe('SheenSync tracking lookup', () => {
  it('asks for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new SheensyncTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ss 2026-0000-0371 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SHEENSYNC_API}?nums=${NUMBER}`);
    expect(String(url)).toBe(sheensyncLookupUrl(NUMBER));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${SHEENSYNC_PAGE}?c=${NUMBER}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sheensync', step: 'direct', outcome: 'ok' }));
  });

  it('reads the delivered sample with wall clocks, codes, the destination and the onward number', () => {
    const result = parseSheensync(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-06-27T08:57:14', expected_delivery: null, destination_country: 'US',
      delivery_tracking_number: 'FD000000000024250' });
    expect(result.events).toHaveLength(21);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![1]).toMatchObject({ location: 'LA_DC Warehouse', description: 'Out for Delivery', stage: 'out_for_delivery' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-06-16T11:06:51', description: 'Shipment information received',
      provider_code: 'IR', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).not.toHaveProperty('location');
    expect(result.events!.find((event) => event.description === 'Shipping Label Created')).not.toHaveProperty('location');
    expect(result.events!.find((event) => event.provider_code === 'AF')).toMatchObject({ location: 'HZ', stage: 'in_transit' });
    expect(result.events!.find((event) => event.description === 'Warehouse pickup')).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/HZXX061414150581|shipper/);
  });

  it('keeps the onward number only when it differs from the waybill', () => {
    for (const onward of ['', NUMBER, null, 'https://example.invalid/x']) {
      expect(parseSheensync(changed((r) => { r.data[0].channel_hawbcode = onward; }), NUMBER).delivery_tracking_number).toBeUndefined();
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseSheensync(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSheensync(changed((r) => { r.data[0].server_hawbcode = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSheensync(changed((r) => { r.data[0].server_hawbcode = 'HZ0'; r.data[0].shipper_hawbcode = NUMBER; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSheensync(changed((r) => { r.data.push(r.data[0]); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSheensync({ success: 0, enmessage: 'Try again later' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSheensync(changed((r) => { r.data[0].details = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseSheensync(changed((r) => { r.data[0].details[0].track_occur_date = '2026-06-31 08:57:14'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: unknown, init?: ResponseInit) => new SheensyncTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://sheen-sync.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the site', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network')).mockResolvedValueOnce(response(fixture('delivered')));
    await expect(new SheensyncTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeSheensyncNumber('ss202600000371')).toBe(NUMBER);
    for (const number of ['202600000371', 'SS20260000037', 'SS2026000003710', 'SX202600000371', 'LA123456789CN']) {
      expect(() => normalizeSheensyncNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SheensyncTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new SheensyncTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'sheensync', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the forwarder codes and the line haul wordings', () => {
    expect(sheensyncStage('Shipment information received', 'IR')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(sheensyncStage('Shipment is in transit to next facility', 'PBGJ')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(sheensyncStage('The shipment is being transshipped via the hub')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(sheensyncStage('Out for Delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(sheensyncStage('仓库作业')).toBeNull();
    expect(statusMap.stage('DF', 'Shipment departed from facility')).toBe('in_transit');
    expect(statusMap.stage(null, 'Warehouse pickup')).toBe('in_transit');
  });
});
