import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { DisuTracker } from './adapter.js';
import { DISU_ENDPOINT, DISU_PAGE, normalizeDisuNumber, parseDisu } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '516050936706';
const STATION = '516057854686';
const IN_TRANSIT = '516058158759';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('Disu Logistics guest adapter', () => {
  it('posts the waybill in the query as the tracking box does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new DisuTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 5160 5093 6706 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${DISU_ENDPOINT}?billcode=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: '', headers: { 'Content-Type': 'text/plain', Referer: DISU_PAGE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-11-01T21:52:29', last_status_text: '您的包裹已送达签收 · 深圳市' });
  });

  it('keeps local clocks, scans and places without the courier, the signatory, phones or notices', () => {
    const result = parseDisu(page('delivered.html'), DELIVERED);
    expect(result.events).toHaveLength(16);
    expect(result.events!.slice(0, 4).map(event => [event.local_time, event.provider_code, event.location, event.stage, event.description])).toEqual([
      ['2026-11-01T21:52:29', '签收', '深圳市', 'delivered', '您的包裹已送达签收'],
      ['2026-11-01T21:50:44', '派送', '深圳市', 'out_for_delivery', '快递员正在为您派送'],
      ['2026-11-01T21:50:43', '到达站点', '深圳市', 'in_transit', '您的包裹已经进入【深圳福永站Z】准备分配快递员'],
      ['2026-11-01T10:29:42', '再次派送', undefined, 'failed_attempt', '包裹将在收件人要求的时间内再次派送，请耐心等待'],
    ]);
    // Single-digit hours are padded and the page's order holds on equal clocks.
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-10-31T02:04:48', provider_code: '分拣', location: '广州市' });
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/井慧|本人|客服|物流问题|956160|\d{7,}/);
  });

  it('keeps a pickup station and the delivering partner\'s waybill without its phones', () => {
    const result = parseDisu(page('pickup-station.html'), STATION);
    expect(result.events!.find(event => event.provider_code === '暂存')).toMatchObject({ location: '茂名市', stage: 'ready_for_pickup',
      description: '快件已由树仔快递喵站(多客隆客旁10米，上班9点-18.30分)暂存，可凭取件码到站取件 代派单号:621253193194029' });
    expect(result.events!.find(event => event.provider_code === '预计到达')).toMatchObject({ location: '山东济宁转运中心', stage: 'in_transit' });
    expect(result).toMatchObject({ status: 'delivered', last_status_text: '已签收，签收人凭取件码签收', delivery_tracking_number: '621253193194029' });
    expect(JSON.stringify(result)).not.toMatch(/树仔-|投诉|19388257273|16611305457/);
    expect(parseDisu(page('in-transit.html'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', last_update_local: '2026-11-03T02:42:59' });
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new DisuTracker({ fetcher }).fetch('999999999990')).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseDisu(page('delivered.html'), '516050936707')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDisu(page('delivered.html').replace('2026/11/1 3:56:42', '2026/2/30 3:56:42'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDisu(page('delivered.html').replace('2026/11/1 3:56:42', '2026/11/1'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDisu(page('delivered.html') + page('in-transit.html'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDisu('<html>maintenance</html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeDisuNumber('ds123456789012345')).toBe('DS123456789012345');
    for (const number of ['51605093670', '5160509367061', '516050936706123', 'DS12345678901234']) {
      expect(() => normalizeDisuNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseDisu('<html><title>Just a moment...</title></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new DisuTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the scans and leaves others without a stage', () => {
    expect(statusMap.stage('签收', '')).toBe('delivered');
    expect(statusMap.stage('暂存', '')).toBe('ready_for_pickup');
    expect(statusMap.stage('退回', '')).toBeUndefined();
    const html = page('delivered.html').replace(/您的包裹已送达签收，由本人签收[^<]*/, '您的包裹已退回');
    const result = parseDisu(html, DELIVERED);
    expect(result.events![0]).toMatchObject({ description: '您的包裹已退回', location: '深圳市' });
    expect(result.events![0]!.provider_code).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '您的包裹已退回 · 深圳市' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('disu-logistics');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'disu-logistics', number: DELIVERED });
    expect(tracked.source).toBe('disu-logistics');
    expect(tracked.result.status).toBe('delivered');
  });
});
