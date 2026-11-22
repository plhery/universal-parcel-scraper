import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { PadtfTracker } from './adapter.js';
import { normalizePadtfNumber, PADTF_CAPTCHA, PADTF_PAGE, parsePadtf } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '880013649535';
const UNKNOWN = '999999999990';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PICTURE = readFileSync(new URL('./fixtures/captcha-K36E.png', import.meta.url));

/** A tracker that hands out pictures and answers the form, accepting one code. */
function site(options: { lookup?: () => Response; accepted?: string } = {}) {
  let session = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    const headers = new Headers(init?.headers);
    expect(headers.get('referer')).toBe(PADTF_PAGE);
    if (target.startsWith(`${PADTF_CAPTCHA}?`)) {
      session += 1;
      const response = new Response(PICTURE, { headers: { 'Content-Type': 'image/png', 'Set-Cookie': `PHPSESSID=synthetic${session}; path=/` } });
      // The cookie jar files a cookie under the address that answered.
      Object.defineProperty(response, 'url', { value: target });
      return response;
    }
    if (target === PADTF_PAGE && init?.method === 'POST') {
      expect(headers.get('cookie')).toBe(`PHPSESSID=synthetic${session}`);
      expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init.body));
      if (form.get('user_yzm') !== (options.accepted ?? 'K36E')) return new Response(page('captcha-refused.html'));
      return options.lookup?.() ?? new Response(page('delivered.html'));
    }
    throw new Error(`unexpected ${target}`);
  });
  return fetcher;
}

describe('PAD Express guest adapter', () => {
  it('solves the picture in its session and reads the whole waybill', async () => {
    const fetcher = site();
    const tracker = new PadtfTracker({ fetcher, userAgent: 'SyntheticHost/1' });
    try {
      const result = await tracker.fetch(` ${DELIVERED} `, { budgetMs: 20_000 });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)).get('seark')).toBe(DELIVERED);
      expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
        last_update_local: '2026-11-14T18:01:25', last_status_text: '快件已送达，派送站点【石基】' });
    } finally { await tracker.close(); }
  }, 30_000);

  it('keeps branch names and local clocks without phones, the courier or the signatory', () => {
    const result = parsePadtf(page('delivered.html'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-11-14T18:01:25', '快件已送达', '快件已送达，派送站点【石基】', '石基', 'delivered'],
      ['2026-11-14T17:10:32', '快件派件中', '快件派件中，【石基】站正在为你派送', '石基', 'out_for_delivery'],
      ['2026-11-14T15:49:13', '快件到达', '快件到达【石基】站', '石基', 'in_transit'],
      ['2026-11-14T14:07:20', '离开', '离开【东莞分拨中心】发往【石基】站', '东莞分拨中心', 'in_transit'],
      ['2026-11-14T11:04:52', '已揽件', '已揽件，揽件网点【大岑】', '大岑', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/电话|\d{7,}|刘韬|图片验收|涂琳琳/);
  });

  it('asks for another picture after a refused answer, and stops after four', async () => {
    const solveCaptcha = vi.fn().mockResolvedValueOnce('ABCD').mockResolvedValueOnce('k36').mockResolvedValue('K36E');
    const fetcher = site();
    const result = await new PadtfTracker({ fetcher, solveCaptcha }).fetch(DELIVERED, { budgetMs: 20_000 });
    expect(result.status).toBe('delivered');
    // The three-character reading is not sent.
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    const refused = site({ accepted: 'NONE' });
    await expect(new PadtfTracker({ fetcher: refused, solveCaptcha: async () => 'K36E' }).fetch(DELIVERED, { budgetMs: 30_000 }))
      .rejects.toMatchObject({ kind: 'challenge', message: expect.stringContaining('refused every captcha answer') });
    expect(refused.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(4);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = site({ lookup: () => new Response(page('not-found.html')) });
    await expect(new PadtfTracker({ fetcher, solveCaptcha: async () => 'K36E' }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parsePadtf(page('delivered.html'), '880013649536')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePadtf(page('delivered.html').replace('2026-11-14 15:49:13', '2026-02-30 15:49:13'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePadtf('<html>maintenance</html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['88001364953', '8800136495350', 'PAD880013649535']) {
      expect(() => normalizePadtfNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parsePadtf(page('captcha-refused.html'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parsePadtf('<html><title>Just a moment...</title></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
      await expect(new PadtfTracker({ fetcher, solveCaptcha: async () => 'K36E' }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the opening phrases and leaves others without a stage', () => {
    expect(statusMap.stage('快件已送达', '')).toBe('delivered');
    expect(statusMap.stage('快件派件中', '')).toBe('out_for_delivery');
    expect(statusMap.stage('退回', '')).toBeUndefined();
    const html = page('delivered.html').replace('<li>2026-11-14 18:01:25-快件已送达', '<li>2026-11-14 18:01:25-快件退回<b>【石基】</b></li><li>2026-11-14 18:01:20-快件已送达');
    const result = parsePadtf(html, DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '快件退回', description: '快件退回【石基】', location: '石基' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('padtf');
    const tracked = await createTracker({ fetcher: site(), env: {}, providers: [] }).track({ carrier: 'padtf', number: DELIVERED });
    expect(tracked.source).toBe('padtf');
    expect(tracked.result.status).toBe('delivered');
  }, 30_000);
});
