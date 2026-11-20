import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, XINGYOU_API, XINGYOU_CALLBACK, XingyouTracker, xingyouLookupUrl } from './adapter.js';
import { normalizeXingyouNumber, parseXingyou } from './parser.js';
import { statusMap, xingyouStage } from './status.js';

const NUMBER = 'XY2422647257PQ';
const UNKNOWN = 'XY0000000000PQ';
const raw = (name: 'in-transit' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; channel_hawbcode: unknown; details: { track_occur_date: unknown }[] }[] }
const fixture = (name: 'in-transit' | 'not-found') => rtb56Json(raw(name), 'jsonp', 'test') as Reply;
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('in-transit'); change(reply); return reply; };
// The tenant answers in the callback the request names.
const jsonp = (body: string) => body.replace(/^jsonp\(/, `${XINGYOU_CALLBACK}(`);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Xingyou tracking lookup', () => {
  it('asks the tenant for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(jsonp(raw('in-transit'))));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new XingyouTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' xy 2422-6472-57pq ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(xingyouLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(XINGYOU_API);
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: XINGYOU_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [NUMBER] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0',
    } });
    // The tenant answers a bare null to a request that names a Referer.
    expect(init?.headers).not.toHaveProperty('Referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xingyou', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample with wall clocks, its codes and the destination', () => {
    const result = parseXingyou(fixture('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'Arrived at USPS Facility', last_update: null, last_update_local: '2026-11-18T21:16:07', expected_delivery: null,
      destination_country: 'US' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events).toHaveLength(13);
    // Xingyou's own rows at the destination state +08:00 too, so every row keeps its wall clock.
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![0]).toMatchObject({ location: 'CHICAGO IL LOGISTICS CENTER,US', description: 'Arrived at USPS Facility' });
    expect(result.events![3]).toMatchObject({ location: 'US', description: 'Under Clearance', provider_code: 'F2', stage: 'customs' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-11-07T10:12:17', description: 'Shipment information received',
      provider_code: 'IR', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.at(-2)).toMatchObject({ provider_code: 'AF', stage: 'accepted', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/XM1D40M038309|60131/);
  });

  it('keeps the onward number only when it differs from the waybill', () => {
    expect(parseXingyou(changed((r) => { r.data[0]!.channel_hawbcode = '9200190000000000000000'; }), NUMBER).delivery_tracking_number)
      .toBe('9200190000000000000000');
    for (const onward of ['', NUMBER, null, 'https://example.invalid/x']) {
      expect(parseXingyou(changed((r) => { r.data[0]!.channel_hawbcode = onward; }), NUMBER).delivery_tracking_number).toBeUndefined();
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseXingyou(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseXingyou(changed((r) => { r.data[0]!.server_hawbcode = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXingyou(changed((r) => { r.data.push(r.data[0]!); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXingyou({ success: 0, enmessage: 'Try again later' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXingyou(changed((r) => { r.data[0]!.details = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseXingyou(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-11-31 21:16:07'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new XingyouTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(jsonp(raw('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(jsonp(raw('in-transit')), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://xygyl.rtb56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    // The tenant's refusal is a bare null, never a missing parcel.
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the site', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(jsonp(raw('in-transit'))));
    await expect(new XingyouTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ destination_country: 'US' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeXingyouNumber('xy2422647257pq')).toBe(NUMBER);
    for (const number of ['XY1234567PQ', 'XY2422647257', 'XY2422647257YQ', 'XX2422647257PQ', 'XY242264725APQ', 'LA123456789CN']) {
      expect(() => normalizeXingyouNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new XingyouTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new XingyouTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'xingyou', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the line\'s codes', () => {
    expect(xingyouStage('Shipment information received', 'IR')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(xingyouStage('Shipment arrived at facility', 'AF')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(xingyouStage('Under Clearance', 'F2')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(xingyouStage('Arrived at USPS Facility')).toMatchObject({ stage: 'in_transit' });
    expect(xingyouStage('仓库作业')).toBeNull();
    expect(statusMap.stage('DDC', 'Destination country customs clearance completed')).toBe('in_transit');
  });
});
