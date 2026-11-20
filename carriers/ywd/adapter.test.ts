import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, YWD_API, YWD_CALLBACK, YWD_PAGE, YwdTracker, ywdLookupUrl } from './adapter.js';
import { normalizeYwdNumber, parseYwd } from './parser.js';
import { statusMap, ywdStage } from './status.js';

const NUMBER = 'YT20260000014144YT';
const UNKNOWN = 'YT00000000000000YT';
const raw = (name: 'in-transit' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; channel_hawbcode: unknown; details: { track_occur_date: unknown }[] }[] }
const fixture = (name: 'in-transit' | 'not-found') => rtb56Json(raw(name), 'jsonp', 'test') as Reply;
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('in-transit'); change(reply); return reply; };
// The tenant answers in the callback the request names.
const jsonp = (body: string) => body.replace(/^jsonp\(/, `${YWD_CALLBACK}(`);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('YWD tracking lookup', () => {
  it('asks the tenant for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(jsonp(raw('in-transit'))));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new YwdTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' yt 2026-0000-0141-44 yt ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ywdLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(YWD_API);
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: YWD_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [NUMBER] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${YWD_PAGE}?c=${NUMBER}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ywd', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample with wall clocks, its codes and the destination', () => {
    const result = parseYwd(fixture('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'Sorting - forwarding', last_update: null, last_update_local: '2026-11-20T07:52:09', expected_delivery: null,
      destination_country: 'CH' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    // The repeated arrival row is read once.
    expect(result.events).toHaveLength(15);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![1]).toMatchObject({ description: 'Customs clearance process underway', stage: 'customs' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-11-09T02:13:46', description: 'Parcel information received',
      provider_code: 'IR', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.at(-2)).toMatchObject({ location: 'SHANGHAI', provider_code: 'AF', stage: 'accepted' });
    expect(result.events!.find((event) => event.description === 'Parcel Infomation Received')).toMatchObject({ stage: 'registered',
      stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/XM8ME110739/);
  });

  it('keeps the onward number only when it differs from the waybill', () => {
    expect(parseYwd(changed((r) => { r.data[0]!.channel_hawbcode = 'LV123456789CH'; }), NUMBER).delivery_tracking_number)
      .toBe('LV123456789CH');
    for (const onward of ['', NUMBER, null, 'https://example.invalid/x']) {
      expect(parseYwd(changed((r) => { r.data[0]!.channel_hawbcode = onward; }), NUMBER).delivery_tracking_number).toBeUndefined();
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseYwd(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYwd(changed((r) => { r.data[0]!.server_hawbcode = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYwd(changed((r) => { r.data.push(r.data[0]!); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYwd({ success: 0, enmessage: 'Try again later' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYwd(changed((r) => { r.data[0]!.details = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseYwd(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-11-31 07:52:09'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new YwdTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(jsonp(raw('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(jsonp(raw('in-transit')), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://lhq.rtb56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the site', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(jsonp(raw('in-transit'))));
    await expect(new YwdTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ destination_country: 'CH' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeYwdNumber('yt20260000014144yt')).toBe(NUMBER);
    for (const number of ['YT2632100702521642', 'YT123456789YT', 'YT20260000014144', 'YX20260000014144YT', 'YT2026000001414AYT', 'LA123456789CN']) {
      expect(() => normalizeYwdNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new YwdTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new YwdTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'ywd', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the line\'s codes and wordings', () => {
    expect(ywdStage('Parcel information received', 'IR')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(ywdStage('Shipment Arrived At Distribution Center', 'AF')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(ywdStage('Parcel Infomation Received')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(ywdStage('Arrived at Import Airport')).toMatchObject({ stage: 'in_transit' });
    expect(ywdStage('仓库作业')).toBeNull();
    expect(statusMap.stage('DF', 'Start Site Transport Shipment')).toBe('in_transit');
  });
});
