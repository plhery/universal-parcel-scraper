import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WhwdtTracker, WHWDT_HOST } from './adapter.js';
import { itdidaCountry, itdidaLookupUrl } from './itdida.js';
import { normalizeWhwdtNumber, parseWhwdt } from './parser.js';
import { statusMap, whwdtStage } from './status.js';

const NUMBER = 'R230199787761A';
const UNKNOWN = 'R000000000000A';
const fixture = (name: 'delivered' | 'not-found') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'text/plain; charset=UTF-8' }, ...init });

describe('Wuhan Wodetong ITDIDA tenant', () => {
  it('asks the tenant for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new WhwdtTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' r2301-9978-7761a ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://${WHWDT_HOST}/itdida-api/queryTracks?no=${NUMBER}`);
    expect(String(url)).toBe(itdidaLookupUrl(WHWDT_HOST, NUMBER));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'whwdt', step: 'direct', outcome: 'ok' }));
  });

  it('reads the delivered sample with wall clocks, without postcodes and with the destination', () => {
    const result = parseWhwdt(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered, Front Door/Porch',
      last_update: null, last_update_local: '2023-02-06T12:40:00', expected_delivery: null, destination_country: 'US' });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.events).toHaveLength(21);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![0]).toMatchObject({ location: 'PERRIS CA', stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2023-01-17T13:57:33', location: '深圳', description: '已预报',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.find((event) => event.description === '收货扫描')).toMatchObject({ stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events!.find((event) => event.description === 'Parcel information received')).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/92570|90220/);
  });

  it('keeps a stated offset, the onward number and drops who signed', () => {
    const reply = changed((r) => {
      r.data[0].trackList[0].timezone = '-08:00';
      r.data[0].trackList[0].desc = 'Delivered, signed by J. SAMPLE';
      r.data[0].detail.zhuanDanHao = '9200 1902 4219 5300 0000 01';
    });
    const result = parseWhwdt(reply, NUMBER);
    expect(result.events![0]).toMatchObject({ time: '2023-02-06T12:40:00-08:00', description: 'Delivered' });
    expect(result.last_update).toBe('2023-02-06T12:40:00-08:00');
    expect(result.delivery_tracking_number).toBe('9200190242195300000001');
    expect(parseWhwdt(changed((r) => { r.data[0].detail.zhuanDanHao = NUMBER; }), NUMBER).delivery_tracking_number).toBeUndefined();
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseWhwdt(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseWhwdt(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWhwdt(changed((r) => { r.data[0].no = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWhwdt(changed((r) => { r.data.push(r.data[0]); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWhwdt(changed((r) => { r.data[0].errorMsg = '查询过于频繁'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWhwdt(changed((r) => { r.success = false; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWhwdt(changed((r) => { r.data[0].trackList = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseWhwdt(changed((r) => { r.data[0].trackList[0].time = '2023-02-06 24:00:00'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: unknown, init?: ResponseInit) => new WhwdtTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(fixture('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.itdida.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ data: 'too busy', statusCode: 503, success: false }, { status: 503 })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('<html>503 Service Temporarily Unavailable</html>', { status: 503 })).rejects.toMatchObject({ kind: 'maintenance' });
    expect(() => parseWhwdt({ data: 'too busy', statusCode: 503, success: false }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeWhwdtNumber('r230199787761a')).toBe(NUMBER);
    for (const number of ['230199787761', 'R23019978776A', 'RR230199787761', 'R230199787761AA', 'LA123456789CN']) {
      expect(() => normalizeWhwdtNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new WhwdtTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
    expect(instance).toMatchObject({ id: 'whwdt', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the forwarder wordings and Chinese country names', () => {
    expect(whwdtStage('已预报')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(whwdtStage('Out for Delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(whwdtStage('仓库作业')).toBeNull();
    expect(statusMap.stage(null, '离开扫描')).toBe('in_transit');
    expect(itdidaCountry('美国')).toBe('US');
    expect(itdidaCountry('英国')).toBe('GB');
    expect(itdidaCountry('Germany')).toBe('DE');
    expect(itdidaCountry('火星')).toBeNull();
  });
});
