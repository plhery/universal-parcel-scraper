import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, DPDEX_API, DPDEX_CALLBACK, DPDEX_PAGE, DpdexTracker, dpdexLookupUrl } from './adapter.js';
import { normalizeDpdexNumber, parseDpdex } from './parser.js';
import { dpdexStage, statusMap } from './status.js';

const NUMBER = 'DPE00019908940';
const UNKNOWN = 'DPE99999999999';
const raw = (name: 'in-transit' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; channel_hawbcode: unknown; details: { track_occur_date: unknown }[] }[] }
const fixture = (name: 'in-transit' | 'not-found') => rtb56Json(raw(name), 'jsonp', 'test') as Reply;
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('in-transit'); change(reply); return reply; };
// The tenant answers in the callback the request names.
const jsonp = (body: string) => body.replace(/^jsonp\(/, `${DPDEX_CALLBACK}(`);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('DpdEx tracking lookup', () => {
  it('asks the tenant for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(jsonp(raw('in-transit'))));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new DpdexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' dpe 0001-9908-940 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(dpdexLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(DPDEX_API);
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: DPDEX_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [NUMBER] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${DPDEX_PAGE}?track_number=${NUMBER}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpdex', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample with wall clocks, codes, the destination and the onward number', () => {
    const result = parseDpdex(fixture('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Flight departure', last_update: null, last_update_local: '2026-11-20T11:45:04', expected_delivery: null,
      destination_country: 'GB', delivery_tracking_number: 'H04Z7A0055780905' });
    expect(result.events).toHaveLength(8);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['HBQF', 'in_transit'], ['STTA', 'in_transit'], ['HCAP', 'in_transit'], ['AA', 'customs'],
      ['DF', 'in_transit'], ['AF', 'accepted'], ['IR', 'registered'], [undefined, 'registered'],
    ]);
    expect(result.events![5]).toMatchObject({ location: 'SZ', description: 'We have your parcel' });
    expect(result.events![0]).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/SN261117043446/);
  });

  it('keeps the onward number only when it differs from the waybill', () => {
    for (const onward of ['', NUMBER, null, 'https://example.invalid/x']) {
      expect(parseDpdex(changed((r) => { r.data[0]!.channel_hawbcode = onward; }), NUMBER).delivery_tracking_number).toBeUndefined();
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseDpdex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDpdex(changed((r) => { r.data[0]!.server_hawbcode = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDpdex(changed((r) => { r.data[0]!.server_hawbcode = 'SN261117043446'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDpdex(changed((r) => { r.data.push(r.data[0]!); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDpdex({ success: 0, enmessage: 'Try again later' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDpdex(changed((r) => { r.data[0]!.details = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseDpdex(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-11-31 11:45:04'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new DpdexTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(jsonp(raw('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(jsonp(raw('in-transit')), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://client.duopudaexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the site', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(jsonp(raw('in-transit'))));
    await expect(new DpdexTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeDpdexNumber('dpe00019908940')).toBe(NUMBER);
    for (const number of ['00019908940', 'DPE0001990894', 'DPE000199089401', 'DPD00019908940', 'LA123456789CN']) {
      expect(() => normalizeDpdexNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new DpdexTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new DpdexTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'dpdex', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the forwarder codes and the relayed label', () => {
    expect(dpdexStage('Shipment information received', 'IR')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(dpdexStage('Export Scan', 'AA')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(dpdexStage('We have received the details for this parcel and expect it to reach the Evri network shortly'))
      .toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(dpdexStage('Out for delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(dpdexStage('仓库作业')).toBeNull();
    expect(statusMap.stage('HBQF', 'Flight departure')).toBe('in_transit');
  });
});
