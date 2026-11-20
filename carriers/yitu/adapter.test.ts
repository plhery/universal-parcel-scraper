import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, YITU_API, YITU_CALLBACK, YITU_PAGE, YituTracker, yituLookupUrl } from './adapter.js';
import { normalizeYituNumber, parseYitu } from './parser.js';
import { statusMap, yituStage } from './status.js';

const NUMBER = 'Y890911042243T';
const UNKNOWN = 'Y000000000000T';
const raw = (name: 'in-transit' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; channel_hawbcode: unknown; details: { track_occur_date: unknown }[] }[] }
const fixture = (name: 'in-transit' | 'not-found') => rtb56Json(raw(name), 'jsonp', 'test') as Reply;
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('in-transit'); change(reply); return reply; };
// The tenant answers in the callback the request names.
const jsonp = (body: string) => body.replace(/^jsonp\(/, `${YITU_CALLBACK}(`);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('YITU tracking lookup', () => {
  it('asks the tenant for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(jsonp(raw('in-transit'))));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new YituTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' y 8909-1104-2243 t ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(yituLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(YITU_API);
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: YITU_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [NUMBER] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: YITU_PAGE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'yitu', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample with wall clocks, its codes and the destination', () => {
    const result = parseYitu(fixture('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '快件操作完成', last_update: null, last_update_local: '2026-11-19T14:16:44', expected_delivery: null,
      destination_country: 'DE', delivery_tracking_number: '00340433979220342362' });
    expect(result.events).toHaveLength(8);
    // The delivering carrier's rows state +08:00 too, so every row keeps its wall clock.
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![0]).toEqual({ local_time: '2026-11-19T14:16:44', location: 'ZHEJIANG', description: '快件操作完成',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![1]).toMatchObject({ description: '快件到达作业中心', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![2]).toMatchObject({ location: 'YIWU', provider_code: 'DF', stage: 'in_transit' });
    // A recipient's delivery choice is not a stage.
    expect(result.events![3]).not.toHaveProperty('stage');
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-11-15T22:34:15', description: 'Shipment information received',
      provider_code: 'IR', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.at(-2)).toMatchObject({ location: 'YIWU', provider_code: 'AF', stage: 'accepted', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/892631807970631/);
  });

  it('keeps the onward number only when it differs from the waybill', () => {
    expect(parseYitu(changed((r) => { r.data[0]!.channel_hawbcode = 'LV123456789DE'; }), NUMBER).delivery_tracking_number)
      .toBe('LV123456789DE');
    for (const onward of ['', NUMBER, null, 'https://example.invalid/x']) {
      expect(parseYitu(changed((r) => { r.data[0]!.channel_hawbcode = onward; }), NUMBER).delivery_tracking_number).toBeUndefined();
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseYitu(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYitu(changed((r) => { r.data[0]!.server_hawbcode = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYitu(changed((r) => { r.data.push(r.data[0]!); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYitu({ success: 0, enmessage: 'Try again later' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYitu(changed((r) => { r.data[0]!.details = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseYitu(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-11-31 14:16:44'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new YituTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(jsonp(raw('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(jsonp(raw('in-transit')), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://ytgyl.rtb56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    // A busy tenant is inconclusive, never a missing parcel.
    await expect(lookup('{"success":0,"cnmessage":"服务忙，请稍后重试","enmessage":"The service is busy, please try again later"}'))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the site', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(jsonp(raw('in-transit'))));
    await expect(new YituTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ destination_country: 'DE' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeYituNumber('y890911042243t')).toBe(NUMBER);
    for (const number of ['Y123456789T', 'Y890911042243', 'Y890911042243X', 'X890911042243T', 'Y89091104224AT', 'YT20260000014144YT', 'LA123456789CN']) {
      expect(() => normalizeYituNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new YituTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new YituTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'yitu', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the line\'s codes and its uncoded wordings', () => {
    expect(yituStage('Shipment information received', 'IR')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(yituStage('快件到达作业中心', 'AF')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(yituStage('快件到达作业中心')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(yituStage('Arrived at DHL Facility')).toMatchObject({ stage: 'in_transit' });
    expect(yituStage('仓库作业')).toBeNull();
    expect(statusMap.stage('DF', 'Shipment departed from facility')).toBe('in_transit');
  });
});
