import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, xsbPageUrl } from './adapter.js';
import { normalizeXsbNumber, parseXsb, xsbWording } from './parser.js';
import { statusMap, xsbStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.html');
const notFound = fixture('not-found.html');
const number = '20023847';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('Xinshengbang Logistics numbers', () => {
  it('takes a waybill or cargo number in letters and digits', () => {
    expect(normalizeXsbNumber(' 2002 3847 ')).toBe(number);
    for (const raw of ['1234', 'ABCDEFGH', `${number}/x`, '1'.repeat(31)]) {
      expect(() => normalizeXsbNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Xinshengbang Logistics tracker', () => {
  it('opens the number\'s tracking page, as the site\'s search box does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(delivered));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(xsbPageUrl(number));
    expect(String(url)).toBe(`http://www.xsb56.cn/Tracking_${number}.shtml`);
    expect(init?.method).toBe('GET');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '3月10号回访客户已签收', last_update: '2023-03-10T10:32:15+08:00', last_update_local: '2023-03-10T10:32:15',
    });
  });

  it('reads the rows newest first on the branches\' wall clock, without the contact row', () => {
    const { events = [] } = parseXsb(delivered, number);
    expect(events.map((event) => [event.local_time, event.time, event.time_zone_basis, event.location, event.description, event.stage])).toEqual([
      ['2023-03-10T10:32:15', '2023-03-10T10:32:15+08:00', 'carrier', undefined, '3月10号回访客户已签收', 'delivered'],
      ['2023-03-10T10:29:15', '2023-03-10T10:29:15+08:00', 'carrier', undefined, '今日派送', 'out_for_delivery'],
      ['2023-03-07T11:05:34', '2023-03-07T11:05:34+08:00', 'carrier', undefined, '今日到达站点', 'in_transit'],
      ['2023-03-07T08:10:53', '2023-03-07T08:10:53+08:00', 'carrier', undefined, '转送出库', 'in_transit'],
      ['2023-03-06T16:54:43', '2023-03-06T16:54:43+08:00', 'carrier', '深圳', '已开单入库', 'accepted'],
    ]);
    const text = JSON.stringify(parseXsb(delivered, number));
    for (const leak of ['13900000000', '13800000000', '0755', '电话']) expect(text).not.toContain(leak);
  });

  it('places a row at the city and branch it starts with, and drops contacts', () => {
    // Synthetic rows in the platform's templates.
    expect(xsbWording('深圳(龙华)已开单入库')).toEqual({ description: '已开单入库', location: '深圳 龙华' });
    expect(xsbWording('今日派送【查询电话：0755-00000000】')).toEqual({ description: '今日派送' });
    expect(xsbWording('已签收，签收人【张三】')).toEqual({ description: '已签收' });
  });

  it('stages every recorded wording, and others by the shared rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage('', entry.wording)).toBe(entry.stage);
    expect(xsbStage('3月12号回访客户已签收')?.stage).toBe('delivered');
    // Synthetic: a wording the map does not know falls to the shared rules.
    expect(xsbStage('货物已签收')?.stage).toBe('delivered');
  });

  it('reads the page\'s empty table for an unknown number as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(notFound));
    await expect(tracker(fetcher).track({ number: '98765432' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not take another number\'s page, a changed page or a verification page for a missing shipment', async () => {
    expect(() => parseXsb(delivered, '20023848')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXsb(delivered.replace('<td>2023-03-07 08:10:53</td>', '<td>2023-02-30 08:10:53</td>'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXsb(delivered.replace('<td>2023-03-07 08:10:53</td>', '<td>昨天</td>'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXsb(delivered.replace('<th>跟踪内容</th>', '<th>内容</th>'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXsb(delivered.replace(/<tr>\s*<td>5<\/td>/, '<tr class="x"><td>5</td>'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXsb('<html><head><title>500 Internal Server Error</title></head></html>', number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXsb('<html><head><title>安全验证</title></head></html>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><head><title>Just a moment...</title></head></html>', 403));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const limited = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('', 429));
    await expect(tracker(limited).track({ number })).rejects.toMatchObject({ kind: 'rate_limited' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><body>Runtime Error</body></html>', 500));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
  });
});
