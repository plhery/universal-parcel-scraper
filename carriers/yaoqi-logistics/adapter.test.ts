import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { decodeText } from '../../core/transport/index.js';
import { createTracker } from '../../facade/index.js';
import { YaoqiTracker } from './adapter.js';
import { normalizeYaoqiNumber, parseYaoqi, YAOQI_SITE, YAOQI_TRACK } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '820161769316';
const bytes = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const page = (name: string) => decodeText(bytes(name), 'gb18030');
const response = (body: BodyInit, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=gb2312' } });

describe('Yaoqi Logistics guest adapter', () => {
  it('posts the waybill as the site\'s tracking box does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered.html')));
    const result = await new YaoqiTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 8201 6176 9316 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(YAOQI_TRACK);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: `w=szyqi&cno=${DELIVERED}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: YAOQI_SITE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '长丰万科 派件已签收',
      last_update: null, last_update_local: '2026-10-30T11:13:00' });
  });

  it('keeps scans, sites and minute clocks without the courier, phones or neighbouring sites', () => {
    const result = parseYaoqi(page('delivered.html'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-10-30T11:13:00', '已签收', '长丰万科 派件已签收', '长丰万科', 'delivered'],
      ['2026-10-30T10:56:00', '正在派件', '长丰万科 正在派件', '长丰万科', 'out_for_delivery'],
      ['2026-10-30T10:56:00', '已到达', '快件 已到达 长丰万科', '长丰万科', 'in_transit'],
      ['2026-10-29T07:45:00', '已发出', '快件 已从 合肥分拨中心 发出', '合肥分拨中心', 'in_transit'],
      ['2026-10-29T03:39:00', '已到达', '快件 已到达 合肥分拨中心', '合肥分拨中心', 'in_transit'],
      ['2026-10-28T01:19:00', '已发出', '快件 已从 广州分拨中心 发出', '广州分拨中心', 'in_transit'],
      ['2026-10-27T23:09:00', '已到达', '快件 已到达 广州分拨中心', '广州分拨中心', 'in_transit'],
      ['2026-10-27T23:04:00', '已发出', '快件 已从 大旺三公塘 发出', '大旺三公塘', 'in_transit'],
    ]);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/陈祥冉|如有疑问|电联|\[\p{Script=Han}|安徽|\d{7,}/u);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found.html')));
    await expect(new YaoqiTracker({ fetcher }).fetch('999999999990')).rejects.toMatchObject({ kind: 'not_found' });
    const html = page('delivered.html');
    expect(() => parseYaoqi(html, '820161769317')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYaoqi(html.replace('2026-10-29 03:39', '2026-02-30 03:39'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYaoqi(html.replace('2026-10-29 03:39', '2026-10-29'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYaoqi('<html>maintenance</html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['82016176931', '8201617693160', 'YQ820161769316']) {
      expect(() => normalizeYaoqiNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseYaoqi('<html><title>Just a moment...</title></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new YaoqiTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the scans and leaves others without a stage', () => {
    expect(statusMap.stage('已签收', '')).toBe('delivered');
    expect(statusMap.stage('已发出', '')).toBe('in_transit');
    expect(statusMap.stage('问题件', '')).toBeUndefined();
    const result = parseYaoqi(page('delivered.html').replace('长丰万科 的派件已签收，如有疑问请电联', '长丰万科 快件滞留，如有疑问请电联'), DELIVERED);
    expect(result.events![0]).toMatchObject({ description: '长丰万科 快件滞留', location: '长丰万科' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '长丰万科 快件滞留' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('yaoqi-logistics');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'yaoqi-logistics', number: DELIVERED });
    expect(tracked.source).toBe('yaoqi-logistics');
    expect(tracked.result.status).toBe('delivered');
  });
});
