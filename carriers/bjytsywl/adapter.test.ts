import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BJYTSYWL_TRACKER, BjytsywlTracker } from './adapter.js';
import { bjytsywlText, normalizeBjytsywlNumber, parseBjytsywl } from './parser.js';
import { bjytsywlStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
// The invented number of the not-found fixture.
const UNKNOWN = 'XT73915048226';
// After the sample's newest row.
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
const html = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const withRows = (rows: string) => html('delivered').replace(/<li>\s*<p>[\s\S]*<\/p>\s*<\/li>/, `<li>${rows}</li>`);
const row = (clock: string, wording: string) => `<p><span>${clock}<b class="fr"></b></span><i>${wording}</i></p>`;

describe('Yuantongshengyuan Logistics tracking lookup', () => {
  it('posts the whole number to the tracking page through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(html('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 4)} ${NUMBER.slice(4, 8)}-${NUMBER.slice(8)}`;
    const result = await new BjytsywlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BJYTSYWL_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Referer: BJYTSYWL_TRACKER, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ g: '1', cnum: NUMBER });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bjytsywl', step: 'direct', outcome: 'ok' }));
  });

  it("reads the sample newest first, each row's wall clock dated on China's clock", () => {
    const result = parseBjytsywl(html('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收', last_update: '2020-05-13T13:20:00+08:00', last_update_local: '2020-05-13T13:20:00', expected_delivery: null });
    expect(result.events).toEqual([
      { time: '2020-05-13T13:20:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2020-05-13T13:20:00',
        description: '已签收', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2020-05-13T08:54:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2020-05-13T08:54:00',
        description: '快件已到达【保税区】，准备派件', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2020-05-12T13:44:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2020-05-12T13:44:00',
        description: '快件已到达【广州分拨中心】准备发往【珠海市保税区】', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2020-05-12T00:15:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2020-05-12T00:15:00',
        description: '快件从【北京分拨中心】正在装车，准备飞往【广州分拨中心】', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2020-05-11T17:32:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2020-05-11T17:32:00',
        description: '快件已收', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
  });

  it('takes the person a row names and phone numbers out, keeps a waybill and a signature by the sender, and drops a row left with nothing', () => {
    expect(bjytsywlText('快件已收，收件员张三')).toBe('快件已收');
    expect(bjytsywlText('快件已收，收件员：李四 13900001111')).toBe('快件已收');
    expect(bjytsywlText('快件派送中，派件员王五，电话：010-87654321')).toBe('快件派送中');
    expect(bjytsywlText('已签收，签收人：赵六')).toBe('已签收');
    expect(bjytsywlText('已签收，签收人：寄件人')).toBe('已签收，签收人：寄件人');
    expect(bjytsywlText('已转中通快递，单号：73194550922032')).toBe('已转中通快递，单号：73194550922032');
    const result = parseBjytsywl(withRows(row('2024-03-01 09:00', '快件已收，收件员张三') + row('2024-03-01 10:00', '收件员：张三 13900001111')), NUMBER, READ_AT);
    expect(result.events).toHaveLength(1);
    expect(result.events![0]).toMatchObject({ description: '快件已收', stage: 'accepted' });
    expect(JSON.stringify(result)).not.toMatch(/张三|13900001111/);
  });

  it('keeps one row of a repeated row, and lists rows of one minute in the reverse of their order', () => {
    const result = parseBjytsywl(withRows(row('2024-03-01 09:00', '快件已收') + row('2024-03-01 09:00', '快件已到达【保税区】，准备派件')
      + row('2024-03-01 09:00', '快件已到达【保税区】，准备派件')), NUMBER, READ_AT);
    expect(result.events!.map((event) => event.description)).toEqual(['快件已到达【保税区】，准备派件', '快件已收']);
  });

  it('leaves a row the clock would date after the lookup its wall clock alone', () => {
    const result = parseBjytsywl(html('delivered'), NUMBER, Date.parse('2020-05-13T04:00:00Z'));
    expect(result.events![0]).toEqual({ local_time: '2020-05-13T13:20:00', description: '已签收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2020-05-13T13:20:00' });
  });

  it("reads the page's answer for an unknown number as not found and anything else as a failure, never as not found", async () => {
    expect(() => parseBjytsywl(html('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The answer for another number is not this one's.
    expect(() => parseBjytsywl(html('not-found'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBjytsywl(html('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBjytsywl(html('not-found').replace('查询的单号不存在，请重新输入', ''), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBjytsywl(html('delivered').replace(/id="cnum_1"[^>]*>/, (tag) => tag.replace('liinfo', 'other')), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBjytsywl(html('delivered').replace('id="ul_1"', 'id="ul_2"'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBjytsywl(withRows(row('2020-05-32 13:20', '已签收')), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBjytsywl(withRows(row('13/05/2020 13:20', '已签收')), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBjytsywl(withRows(row('2020-05-13 13:20', '收件员张三')), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const notice = '<!DOCTYPE html><html><head><title>跳转提示</title></head><body><h1>请输入要查询的订单号</h1></body></html>';
    expect(() => parseBjytsywl(notice, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const lookup = (body: string, init?: ResponseInit) => new BjytsywlTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(html('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(html('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.bjytsywl.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    // The site printing PHP's failure in place of every page is down, not the parcel missing.
    const failure = '<br />\n<b>Fatal error</b>:  Namespace declaration statement has to be the very first statement or after any declare call in the script in <b>/www/wwwroot/example/public/index.php</b> on line <b>2217</b><br />\n';
    await expect(lookup(failure)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeBjytsywlNumber(` ${NUMBER} `)).toBe(NUMBER);
    for (const number of ['01005', 'ABCDEFGH', `${NUMBER};${NUMBER}`, '1'.repeat(31), '']) {
      expect(() => normalizeBjytsywlNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BjytsywlTracker({ fetcher }).fetch(`${NUMBER};${UNKNOWN}`)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new BjytsywlTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'bjytsywl', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('answers each wording statuses.json records by its stage, and other centres by the same patterns', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMap.stage(null, wording), wording).toBe(stage);
      expect(bjytsywlStage(wording), wording).toEqual({ stage, source: 'carrier_map' });
    }
    expect(statusMap.stage(null, '快件从【上海分拨中心】正在装车，准备发往【西安分拨中心】')).toBe('in_transit');
    expect(statusMap.stage(null, '快件已到达【成都分拨中心】，准备派件')).toBe('in_transit');
    expect(statusMap.stage('1', '已签收')).toBeUndefined();
    expect(bjytsywlStage('已签收，签收人：寄件人')).toMatchObject({ stage: 'returned' });
  });
});
