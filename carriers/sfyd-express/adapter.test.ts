import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, SFYD_API, SFYD_CALLBACK, SFYD_PAGE, SfydTracker, sfydLookupUrl } from './adapter.js';
import { normalizeSfydNumber, parseSfyd } from './parser.js';
import { sfydStage, statusMap } from './status.js';

const NUMBER = 'SFYD26099215028';
const UNKNOWN = 'SFYD00000000000';
const raw = (name: 'forwarded' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; channel_hawbcode: unknown; details: { track_occur_date: unknown }[] }[] }
const fixture = (name: 'forwarded' | 'not-found') => rtb56Json(raw(name), 'jsonp', 'test') as Reply;
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('forwarded'); change(reply); return reply; };
// The tenant answers in the callback the request names.
const jsonp = (body: string) => body.replace(/^jsonp\(/, `${SFYD_CALLBACK}(`);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('SFYD Express tracking lookup', () => {
  it('asks the tenant for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(jsonp(raw('forwarded'))));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new SfydTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' sfyd 2609-9215-028 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(sfydLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(SFYD_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: SFYD_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [NUMBER] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${SFYD_PAGE}?c=${NUMBER}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sfyd-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample with its own instants, the delivering carrier\'s wall clocks and the destination', () => {
    const result = parseSfyd(fixture('forwarded'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'FORWARDED', last_update: null, last_update_local: '2026-10-19T09:37:03', expected_delivery: null,
      destination_country: 'US' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events).toHaveLength(33);
    const own = result.events!.filter((event) => event.time);
    expect(own).toHaveLength(8);
    expect(own.every((event) => event.time!.endsWith('+08:00') && !event.local_time)).toBe(true);
    expect(result.events!.slice(0, 25).every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![1]).toMatchObject({ location: 'HEWITT,NJ', description: 'OUT FOR DELIVERY', stage: 'out_for_delivery' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-10-03T14:43:16+08:00', description: 'Shipment information received',
      provider_code: 'IR', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).not.toHaveProperty('location');
    expect(result.events!.find((event) => event.provider_code === 'AF')).toMatchObject({ location: 'CHINESE MAINLAND',
      description: 'Shipment arrived at facility', stage: 'accepted' });
    expect(result.events!.find((event) => event.description === 'Packaged')).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/892627597158884|07421/);
  });

  it('keeps the onward number only when it differs from the waybill', () => {
    expect(parseSfyd(changed((r) => { r.data[0]!.channel_hawbcode = '9200190000000000000000'; }), NUMBER).delivery_tracking_number)
      .toBe('9200190000000000000000');
    for (const onward of ['', NUMBER, null, 'https://example.invalid/x']) {
      expect(parseSfyd(changed((r) => { r.data[0]!.channel_hawbcode = onward; }), NUMBER).delivery_tracking_number).toBeUndefined();
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseSfyd(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSfyd(changed((r) => { r.data[0]!.server_hawbcode = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSfyd(changed((r) => { r.data[0]!.server_hawbcode = '892627597158884'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSfyd(changed((r) => { r.data.push(r.data[0]!); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSfyd({ success: 0, enmessage: 'Try again later' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSfyd(changed((r) => { r.data[0]!.details = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseSfyd(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-10-32 09:37:03'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new SfydTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(jsonp(raw('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(jsonp(raw('forwarded')), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://sfyd.rtb56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the site', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(jsonp(raw('forwarded'))));
    await expect(new SfydTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeSfydNumber('sfyd26099215028')).toBe(NUMBER);
    for (const number of ['26099215028', 'SFYD1234567', 'SFYD123456789012345', 'SFYX26099215028', 'SFYD2609921502A', 'LA123456789CN']) {
      expect(() => normalizeSfydNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SfydTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new SfydTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'sfyd-express', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the forwarder codes and wordings', () => {
    expect(sfydStage('Shipment information received', 'IR')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(sfydStage('Shipment arrived at facility', 'AF')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(sfydStage('FORWARDED')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(sfydStage('OUT FOR DELIVERY')).toMatchObject({ stage: 'out_for_delivery' });
    expect(sfydStage('仓库作业')).toBeNull();
    expect(statusMap.stage('DF', 'Shipment departed from facility')).toBe('in_transit');
    expect(statusMap.stage(null, 'Packaged')).toBe('in_transit');
  });
});
