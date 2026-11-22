import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { YuxinTracker } from './adapter.js';
import { normalizeYuxinNumber, parseYuxin, YUXIN_CAPTCHA, YUXIN_ENDPOINT, YUXIN_PAGE, yuxinJson } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '3228340140';
const UNKNOWN = '9999999990';
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PICTURE = readFileSync(new URL('./fixtures/captcha-8ZMN.jpg', import.meta.url));
type Waybill = { flows: Record<string, unknown>[]; orders?: Record<string, unknown> };
/** The delivered reply with its waybill edited. */
const edited = (edit: (waybill: Waybill) => void) => {
  const reply = JSON.parse(raw('delivered.json')) as { data: string };
  const data = JSON.parse(reply.data) as Record<string, Waybill>;
  edit(data[DELIVERED]!);
  return { ...reply, data: JSON.stringify(data) };
};

/** A tracker that hands out pictures and answers lookups, accepting one code. */
function site(options: { lookup?: () => Response; accepted?: string } = {}) {
  let session = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url), headers = new Headers(init?.headers);
    expect(headers.get('referer')).toBe(YUXIN_PAGE);
    if (target.startsWith(`${YUXIN_CAPTCHA}?pic_id=&`)) {
      session += 1;
      const response = new Response(PICTURE, { headers: { 'Content-Type': 'image/jpeg', 'Set-Cookie': `jeesite.session.id=synthetic${session}; Path=/; HttpOnly` } });
      // The cookie jar files a cookie under the address that answered.
      Object.defineProperty(response, 'url', { value: target });
      return response;
    }
    if (target === YUXIN_ENDPOINT && init?.method === 'POST') {
      expect(headers.get('cookie')).toBe(`jeesite.session.id=synthetic${session}`);
      expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
      if (new URLSearchParams(String(init.body)).get('req_pic_key') !== (options.accepted ?? '8ZMN')) {
        return Response.json({ status: 400, msg: '验证码不匹配，请重新输入！' });
      }
      return options.lookup?.() ?? new Response(raw('delivered.json'));
    }
    throw new Error(`unexpected ${target}`);
  });
}

describe('Yuxin Logistics guest adapter', () => {
  it('solves the picture in its session and reads the whole waybill', async () => {
    const fetcher = site();
    const tracker = new YuxinTracker({ fetcher, userAgent: 'SyntheticHost/1' });
    try {
      const result = await tracker.fetch(` ${DELIVERED} `, { budgetMs: 20_000 });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)).get('orders')).toBe(DELIVERED);
      expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
        last_update_local: '2026-11-18T15:24:57', last_status_text: '已签收【万州区】' });
    } finally { await tracker.close(); }
  }, 30_000);

  it('words scans as the page does, with local clocks and without staff or customers', () => {
    const result = parseYuxin(JSON.parse(raw('delivered.json')), DELIVERED);
    expect(result.events).toHaveLength(11);
    expect(result.events!.slice(0, 3).map(event => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-11-18T15:24:57', '已签收', '已签收【万州区】', '万州区', 'delivered'],
      ['2026-11-16T17:49:12', '落地', '已到达【万州】', '万州', 'in_transit'],
      ['2026-11-16T12:22:39', '落地', '已到达【万州区】', '万州区', 'in_transit'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-11-11T16:31:57', provider_code: '已揽收',
      description: '已揽收【昌乐济南转】下一站【济南分拣中心】', location: '昌乐济南转', stage: 'accepted' });
    expect(result.events!.find(event => event.provider_code === '已离开')).toMatchObject({ description: '已离开【成都分拣中心】发往【万州区】' });
    expect(JSON.stringify(result)).not.toMatch(/\d{7,}|孟祥强|小丁|赵海良|高梁镇|亿丰/);
  });

  it('says whether every piece arrived on the newest arrival of an unsigned waybill', () => {
    const result = parseYuxin(edited(waybill => { waybill.flows.shift(); waybill.flows[0]!.isArrive = 0; waybill.orders!.orderStatus = '2'; }), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: '已到达【万州】【部分到达】' });
    expect(result.events![1]!.description).toBe('已到达【万州区】');
  });

  it('asks for another picture after a refused answer, and stops after three', async () => {
    const solveCaptcha = vi.fn().mockResolvedValueOnce('ABCD').mockResolvedValueOnce('8ZM').mockResolvedValue('8ZMN');
    const fetcher = site();
    expect((await new YuxinTracker({ fetcher, solveCaptcha }).fetch(DELIVERED, { budgetMs: 20_000 })).status).toBe('delivered');
    // The three-character reading is not sent.
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    const refused = site({ accepted: 'NONE' });
    await expect(new YuxinTracker({ fetcher: refused, solveCaptcha: async () => '8ZMN' }).fetch(DELIVERED, { budgetMs: 30_000 }))
      .rejects.toMatchObject({ kind: 'challenge', message: expect.stringContaining('refused every captcha answer') });
    expect(refused.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(3);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = site({ lookup: () => new Response(raw('not-found.json')) });
    await expect(new YuxinTracker({ fetcher, solveCaptcha: async () => '8ZMN' }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseYuxin(edited(waybill => { waybill.flows = []; }), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const reply of [edited(waybill => { waybill.orders!.orderId = '3228340141'; }), edited(waybill => { waybill.flows[2]!.operateDate = '2026-02-30 10:00:00'; }),
      edited(waybill => { waybill.flows[0]!.operateType = '3'; }), { status: 200, data: '{"3228340141":{"flows":[]}}' }, { status: 200, data: 'not JSON' }]) {
      expect(() => parseYuxin(reply, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const number of ['322834014', '32283401400', 'YX3228340140']) {
      expect(() => normalizeYuxinNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps limits, checks and transport failures distinct', async () => {
    const limited = site({ lookup: () => Response.json({ status: 400, msg: '请求太快，请稍后再试！' }) });
    await expect(new YuxinTracker({ fetcher: limited, solveCaptcha: async () => '8ZMN' }).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(limited.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(() => parseYuxin({ status: 500, msg: '系统异常' }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => yuxinJson('<html><title>Just a moment...</title></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => yuxinJson('<html>maintenance</html>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const [status, kind] of [[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
      await expect(new YuxinTracker({ fetcher, solveCaptcha: async () => '8ZMN' }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the scan types and leaves others without a stage', () => {
    expect(statusMap.stage('已签收', '')).toBe('delivered');
    expect(statusMap.stage('落地', '')).toBe('in_transit');
    expect(statusMap.stage('退回', '')).toBeUndefined();
    const result = parseYuxin(edited(waybill => { waybill.flows.unshift({ ...waybill.flows[1], operateType: 7, operateTypeName: '退回', status: 0, operateDate: '2026-11-19 09:00:00' }); }), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '退回', description: '退回【万州区】发往【万州】' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('yuxin-logistics');
    const tracked = await createTracker({ fetcher: site(), env: {}, providers: [] }).track({ carrier: 'yuxin-logistics', number: DELIVERED });
    expect(tracked.source).toBe('yuxin-logistics');
    expect(tracked.result.status).toBe('delivered');
  }, 30_000);
});
