import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { jingguangCheck, JingguangTracker } from './adapter.js';
import { JINGGUANG_ENDPOINT, JINGGUANG_PAGE, jingguangJson, normalizeJingguangNumber, parseJingguang } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '19811573';
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Reply = { success: boolean; message: string; data: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const edited = (edit: (reply: Reply) => void) => { const reply = fixture('delivered.json'); edit(reply); return reply; };
const response = (body: string, status = 200) => new Response(body, { status });

describe('Jingguang Logistics guest adapter', () => {
  it('sends the waybill with the search page\'s code and its encrypted copy, with no session', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const result = await new JingguangTracker({ fetcher, userAgent: 'SyntheticHost/1', now: () => 1_795_000_000_000, code: () => 'AB3D' })
      .fetch(' 1981 1573 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    const sent = new URL(String(url));
    expect(`${sent.origin}${sent.pathname}`).toBe(JINGGUANG_ENDPOINT);
    expect(Object.fromEntries(sent.searchParams)).toEqual({ code: 'AB3D', key: 'X6c1dBEhQ9TlB6jH6uzAtF5/AoRNDkHamtqO2Ll6xkARbuBJXH8qaGGiaS/b5MJ1', billcode: DELIVERED }); // gitleaks:allow
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Referer: JINGGUANG_PAGE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '已签收', last_update: null,
      last_update_local: '2026-11-11T15:21:08' });
  });

  it('encrypts the code and time as the page\'s script does', async () => {
    const { code, key } = await jingguangCheck('Q7WZ', 1_795_123_456_789);
    const decipher = createDecipheriv('aes-256-cbc', Buffer.from('a6f1b751b31a379360ab170ff7c2451c'), Buffer.from('8a8ff614f12c0724')); // gitleaks:allow
    expect(JSON.parse(Buffer.concat([decipher.update(Buffer.from(key, 'base64')), decipher.final()]).toString())).toEqual({ time: 1_795_123_456_789, code });
    const drawn = new URL(String((await (async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
      await new JingguangTracker({ fetcher }).fetch(DELIVERED);
      return fetcher.mock.calls[0]![0];
    })()))).searchParams.get('code');
    expect(drawn).toMatch(/^[A-Z2-9]{4}$/);
  });

  it('keeps scans in clock order with their branches, without phones or the signatory', () => {
    const result = parseJingguang(fixture('delivered.json'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-11-11T15:21:08', '已签收', '已签收', undefined, 'delivered'],
      ['2026-11-11T09:36:22', '已派件', '【深圳沙井】已派件', '深圳沙井', 'out_for_delivery'],
      ['2026-11-11T09:35:22', '已到达', '已到达【深圳沙井】', '深圳沙井', 'in_transit'],
      ['2026-11-11T04:18:14', '已到达', '已到达【东莞分拨】', '东莞分拨', 'in_transit'],
      ['2026-11-10T21:48:13', '已发往', '已发往【华南操作中心】', '华南操作中心', 'in_transit'],
      ['2026-11-10T20:46:35', '已承运', '已承运【澄海城区营业部】', '澄海城区营业部', 'accepted'],
    ]);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/张福|电话|如有疑问|宝安|\d{7,}/);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found.json')));
    await expect(new JingguangTracker({ fetcher }).fetch('99999990')).rejects.toMatchObject({ kind: 'not_found' });
    for (const reply of [edited(reply => { reply.data[2]!.waybillcode = '19811574'; }),
      edited(reply => { reply.data[2]!.ticketTime = '2026-02-30 04:18:14'; }),
      edited(reply => { reply.data[2]!.ticketTime = '2026/11/11 04:18:14'; }),
      edited(reply => { (reply as Record<string, unknown>).data = {}; })]) {
      expect(() => parseJingguang(reply, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const number of ['1981157', '198115730', 'JG19811573']) {
      expect(() => normalizeJingguangNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps refusals, failures and malformed replies distinct', async () => {
    expect(() => parseJingguang({ success: false, message: 'Key错误' }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJingguang({ success: false, message: '查询过于频繁' }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseJingguang({ success: false, message: '系统异常' }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => jingguangJson('<html><title>Just a moment...</title></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => jingguangJson('<html>maintenance</html>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{}', status));
      await expect(new JingguangTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the scans and leaves others without a stage', () => {
    expect(statusMap.stage('已签收', '')).toBe('delivered');
    expect(statusMap.stage('已派件', '')).toBe('out_for_delivery');
    expect(statusMap.stage('已滞留', '')).toBeUndefined();
    const result = parseJingguang(edited(reply => {
      reply.data.push({ ...reply.data[0]!, ticketDesc: '已滞留【深圳沙井】', ticketTime: '2026-11-11 16:00:00' });
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '已滞留', location: '深圳沙井' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('jingguang-logistics');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'jingguang-logistics', number: DELIVERED });
    expect(tracked.source).toBe('jingguang-logistics');
    expect(tracked.result.status).toBe('delivered');
  });
});
