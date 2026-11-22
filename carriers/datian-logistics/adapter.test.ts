import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { DatianTracker } from './adapter.js';
import { DATIAN_FORM, DATIAN_PAGE, normalizeDatianNumber, parseDatian } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = 'DTW016528697471';
const UNKNOWN = 'DTW999999999990';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('DTW Logistics guest adapter', () => {
  it('reads the redirect target for the whole waybill with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new DatianTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' dtw 0165 2869 7471 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${DATIAN_PAGE}?w=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Referer: DATIAN_FORM, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-11-17T13:59:53', last_status_text: '派送完成 · 昆明' });
  });

  it('keeps steps, stations and local clocks without the sender, recipient, agent, signatory or landmarks', () => {
    const result = parseDatian(page('delivered.html'), DELIVERED);
    expect(result.events).toHaveLength(40);
    expect(result.events!.slice(0, 3).map(event => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2026-11-17T13:59:53', '派送完成', '昆明', 'delivered'],
      ['2026-11-14T11:35:14', '货物出站', '昆明', 'in_transit'],
      ['2026-11-14T11:35:14', '货物进站', '昆明', 'in_transit'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-11-10T15:17:08', description: '货物受理', location: '青岛', stage: 'accepted' });
    // Single-digit hours are padded.
    expect(result.events!.find(event => event.location === '杭州市')).toMatchObject({ local_time: '2026-11-12T08:56:38', provider_code: '货物在途' });
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/张新浩|马慧萍|明月|工会|方向|\d{7,}/);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new DatianTracker({ fetcher }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseDatian(page('delivered.html'), 'DTW016528697472')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDatian(page('delivered.html').replace('<td>DTW016528697471</td>\r\n                                <td>2026/11/17', '<td>DTW016528697472</td>\r\n                                <td>2026/11/17'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDatian(page('delivered.html').replace('2026/11/14 11:35:14', '2026/2/30 11:35:14'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDatian(page('delivered.html').replace('2026/11/14 11:35:14', '2026/11/14'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDatian('<html>maintenance</html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['016528697471', 'DTW01652869747', 'DTX016528697471']) {
      expect(() => normalizeDatianNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseDatian('<html><title>Just a moment...</title></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new DatianTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the steps and leaves others without a stage', () => {
    expect(statusMap.stage('派送完成', '')).toBe('delivered');
    expect(statusMap.stage('货物受理', '')).toBe('accepted');
    expect(statusMap.stage('货物滞留', '')).toBeUndefined();
    const html = page('delivered.html').replace('<td>昆明</td>\r\n                                <td>派送完成</td>', '<td>昆明</td>\r\n                                <td>货物滞留</td>');
    const result = parseDatian(html, DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '货物滞留', location: '昆明' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '货物滞留 · 昆明' });
  });

  it('detects DTW waybills and tracks them', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'datian-logistics', confidence: 'high' });
    expect(detectCarrierMatch('016528697471').candidates ?? []).not.toContain('datian-logistics');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ number: DELIVERED });
    expect(tracked.source).toBe('datian-logistics');
    expect(tracked.result.status).toBe('delivered');
  });
});
