import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, TORBON_API, TORBON_CALLBACK, TorbonTracker, torbonLookupUrl } from './adapter.js';
import { normalizeTorbonNumber, parseTorbon } from './parser.js';
import { statusMap, torbonStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from kuaidi100's carrier list, and an invented number.
const DELIVERED = 'TB2025026636CN';
const UNKNOWN = 'TB0000000000CN';
type Name = 'delivered' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; destination_country: unknown; details: { track_occur_date: unknown; gmt_offset: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), TORBON_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Torbon tracking lookup', () => {
  it('asks the tenant’s lookup on Torbon’s host for the whole waybill, over HTTPS', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new TorbonTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tb 2025-0266-36 cn ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(torbonLookupUrl(DELIVERED));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(TORBON_API);
    expect(asked.protocol).toBe('https:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: TORBON_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [DELIVERED] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'torbon', step: 'direct', outcome: 'ok' }));
  });

  it('reads sea freight delivered to a warehouse in the United States, every scan on the offset it states', () => {
    const result = parseTorbon(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '4.9号已送仓,POD已回传。后续如有疑问,请在15个工作日内及时联系我司。', last_update: '2025-04-16T10:33:48+08:00',
      expected_delivery: null, destination_country: 'US' });
    expect(result.events!.map(({ time, location, provider_code, stage }) => [time, location, provider_code, stage])).toEqual([
      ['2025-04-16T10:33:48+08:00', 'US', undefined, 'delivered'],
      ['2025-04-06T10:00:00+08:00', 'US', undefined, 'in_transit'],
      ['2025-04-03T18:00:00+08:00', 'US', undefined, 'in_transit'],
      ['2025-04-03T09:00:00+08:00', 'US', undefined, 'in_transit'],
      ['2025-03-31T13:22:18+08:00', 'US', undefined, 'in_transit'],
      ['2025-03-29T05:57:00+08:00', 'LOS ANGELES', undefined, 'in_transit'],
      ['2025-03-16T01:25:00+08:00', 'NINGBO', undefined, 'in_transit'],
      ['2025-03-13T09:00:00+08:00', 'NINGBO', undefined, 'in_transit'],
      ['2025-03-10T23:00:00+08:00', 'YIWU', undefined, 'in_transit'],
      ['2025-03-05T16:10:19+08:00', 'YIWU', 'AF', 'accepted'],
      ['2025-03-03T14:36:49+08:00', undefined, 'IR', 'registered'],
    ]);
    expect(result.events!.every((event) => !event.local_time && event.stage_source === 'carrier_map')).toBe(true);
    // The arrival in Los Angeles, stated on China's clock, falls on the US day the sailing row expected.
    expect(new Date(result.events![5]!.time!).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })).toBe('2025-03-28');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/upload|\.png|0000000000/i);
  });

  it('keeps a scan without a valid offset on its wall clock', () => {
    const result = parseTorbon(changed((reply) => { reply.data[0]!.details[0]!.gmt_offset = ''; }), DELIVERED);
    expect(result.events![0]).toMatchObject({ local_time: '2025-04-16T10:33:48', stage: 'delivered' });
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result).toMatchObject({ last_update: null, last_update_local: '2025-04-16T10:33:48' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseTorbon(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTorbon(null, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTorbon(changed((r) => { r.data[0]!.server_hawbcode = UNKNOWN; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTorbon(changed((r) => { r.data.push(r.data[0]!); }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTorbon({ success: 0, enmessage: 'Try again later' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTorbon(changed((r) => { r.data[0]!.details = []; }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseTorbon(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2025-04-31 10:33:48'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new TorbonTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(DELIVERED, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(raw('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { location: 'https://oms.torbon.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>验证码</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the tracker', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('delivered')));
    await expect(new TorbonTracker({ fetcher: flaky }).fetch(DELIVERED, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeTorbonNumber('tb2025026636cn')).toBe(DELIVERED);
    for (const number of ['2025026636', 'TB202502663CN', 'TB20250266360CN', 'TB2025026636US', 'TX2025026636CN', 'TB202502663ACN']) {
      expect(() => normalizeTorbonNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new TorbonTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'torbon', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('recognizes by the same lookup', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    await expect(adapter({ fetcher: known, recorder: NOOP_RECORDER } as never).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER } as never).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('maps every code and wording it lists, whatever day the staff name', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code : null;
      expect(statusMap.stage(code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMap.stage(null, normalizeStatusWording('12.31号已送仓,POD已回传。后续如有疑问,请在15个工作日内及时联系我司。'))).toBe('delivered');
    expect(statusMap.stage(null, normalizeStatusWording('预计美国时间10.2号提柜'))).toBe('in_transit');
    expect(torbonStage('Shipment information received', 'IR')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(statusMap.stage(null, normalizeStatusWording('仓库作业'))).toBeUndefined();
  });
});
