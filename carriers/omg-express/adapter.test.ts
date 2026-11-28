import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, OMG_EXPRESS_TRACKING } from './adapter.js';
import { normalizeOmgExpressNumber, parseOmgExpress, withoutContacts } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.html');
const notFound = fixture('not-found.html');
const number = 'OMG2508291001';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const page = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('OMG Express waybill numbers', () => {
  it('takes OMG and the waybill digits, not a phone number or a customer code', () => {
    expect(normalizeOmgExpressNumber(' omg 2508 2910 01 ')).toBe(number);
    for (const raw of ['13800000000', 'OMG1234', '12345', 'OMG2508291001X']) {
      expect(() => normalizeOmgExpressNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('OMG Express tracking page', () => {
  it('opens the tracking page at the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(delivered));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${OMG_EXPRESS_TRACKING}/${number}`);
    expect(init?.method).toBe('GET');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'DELIVERED',
      last_update: null, last_update_local: '2025-09-14T17:45:05', destination_country: 'CN', delivery_tracking_number: '73570607946196',
    });
  });

  it('reads the timeline newest first on its wall clock, without the courier\'s name or any phone number', () => {
    const { events = [] } = parseOmgExpress(delivered, number);
    expect(events).toHaveLength(18);
    expect(events.map((event) => [event.local_time, event.provider_code, event.stage]).slice(-5)).toEqual([
      ['2025-09-09T11:36:00', 'CUSTOMS_CLEARANCE', 'customs'],
      ['2025-09-05T20:04:07', 'IN_TRANSIT', 'in_transit'],
      ['2025-09-03T11:10:42', 'IN_TRANSIT', 'in_transit'],
      ['2025-08-30T11:18:05', 'UNKNOWN', undefined],
      ['2025-08-30T08:37:40', 'CREATED', 'registered'],
    ]);
    expect(events[3]).toEqual({ local_time: '2025-09-12T07:05:17', description: '【保定市】保定雄县 的业务员正在为您派件',
      provider_code: 'OUT_FOR_DELIVERY', location: '保定市', stage: 'out_for_delivery', stage_source: 'carrier_map' });
    expect(events[1]?.description).toBe('【保定市】 您的快递已送达，签收人在【雄东A一号隆昌居公共服务站】取件。感谢使用中通快递，期待再次为您服务！');
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/张三|\d{3,4}-\d{7,8}|1[3-9]\d{9}|95311|无需找商家/);
    expect(events.some((event) => event.time)).toBe(false);
  });

  it('leaves out contacts in other shapes a courier writes them', () => {
    // Synthetic wordings.
    expect(withoutContacts('【杭州市】快件已由【李四,13900000000】揽收')).toBe('【杭州市】快件已揽收');
    expect(withoutContacts('快件已到达 杭州转运中心（如有疑问请联系0571-00000000）')).toBe('快件已到达 杭州转运中心');
    expect(withoutContacts('快件已签收。如有疑问请联系 13900000000。')).toBe('快件已签收。');
  });

  it('stages every recorded code by the map, whatever its wording', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
    expect(statusMap.stage('UNKNOWN', '订单支付完成')).toBeUndefined();
    expect(statusMap.gaps.map((gap) => gap.code)).toEqual(['UNKNOWN']);
  });

  it('reports a number the tracker holds nothing for as not found, only when its address names that number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(notFound));
    await expect(tracker(fetcher).track({ number: 'OMG0000000000' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseOmgExpress(notFound, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseOmgExpress(delivered, 'OMG2508291002')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take a failure, a changed page or a verification page for a missing waybill', async () => {
    expect(() => parseOmgExpress('<html><body>OMG国际速运</body></html>', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOmgExpress(delivered.replaceAll('TrackingTimeline', 'Timeline'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOmgExpress(delivered.replace('2025-09-14 17:45:05', '14/09/2025 17:45'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><head><title>Just a moment...</title></head></html>', 403));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><body>请完成滑块验证</body></html>'));
    await expect(tracker(blocked).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><body>Bad Gateway</body></html>', 503));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><head><title>OMG国际速运</title></head><body></body></html>'));
    await expect(tracker(other).track({ number })).rejects.toMatchObject({ kind: 'schema' });
  });
});
