import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HLTOP_API, HltopTracker } from './adapter.js';
import { hltopText, normalizeHltopNumber, parseHltop } from './parser.js';
import { hltopStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = '9999000017';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Name = 'delivered' | 'not-found';
const bytes = (name: Name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url));
const html = (name: Name) => new TextDecoder('gb18030').decode(bytes(name));
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('Hailian Express tracking lookup', () => {
  it('posts the whole number to the lookup through the supplied transport and reads the page as GB2312', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new HltopTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${NUMBER.slice(0, 4)}-${NUMBER.slice(4)} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(11);
    expect(result.events![0]!.description).toBe('客户签收: 已签收');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(HLTOP_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`id=${NUMBER}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hltop', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first on Shanghai\'s clock, without the address or the courier', () => {
    const result = parseHltop(html('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '客户签收: 已签收', last_update: '2023-05-30T08:09:45+08:00', last_update_local: '2023-05-30T08:09:45',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2023-05-30T08:09:45', '客户签收: 已签收', 'delivered'],
      ['2023-05-30T07:49:11', '派送中', 'out_for_delivery'],
      ['2023-05-30T05:59:10', '运送中, 快件到达 上海浦东浦红店', 'in_transit'],
      ['2023-05-30T03:26:29', '运送中, 快件已发车', 'in_transit'],
      ['2023-05-30T03:26:05', '运送中, 快件在 上海浦江中转场 完成分拣，准备发往 上海浦东浦红店', 'in_transit'],
      ['2023-05-29T22:23:47', '运送中, 快件到达 上海浦江中转场', 'in_transit'],
      ['2023-05-29T21:42:27', '运送中, 快件已发车', 'in_transit'],
      ['2023-05-29T21:28:41', '运送中, 快件在 上海闵行莲花店 完成分拣，准备发往 上海浦江中转场', 'in_transit'],
      ['2023-05-29T19:29:33', '已揽收, 快件运输中', 'accepted'],
      ['2023-05-29T18:51:48', '已揽收, 已收取快件', 'accepted'],
      ['2023-05-29T18:05:11', '上海分拨中心 进行收件确认', 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2023-05-30T08:09:45+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2023-05-30T08:09:45', description: '客户签收: 已签收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/\*|某人|交给|联系/);
  });

  it('dates a row the zone would put after the lookup on its wall clock alone', () => {
    const page = html('delivered').replace('2023-05-30 08:09:45', '2026-11-28 23:00:00');
    expect(parseHltop(page, NUMBER, READ_AT).events![0]).not.toHaveProperty('time');
  });

  it('takes the courier and phones out of a row', () => {
    expect(hltopText('派送中, 快件交给某人，正在派送途中联系')).toBe('派送中');
    expect(hltopText('派送中, 快件交给某人，正在派送途中（联系电话：13800000000）')).toBe('派送中');
    expect(hltopText('运送中, 快件到达  上海浦江中转场 ')).toBe('运送中, 快件到达 上海浦江中转场');
  });

  it('reads the empty tables under the echoed number as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHltop(html('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHltop(html('not-found'), '9999000018')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHltop(html('delivered'), '2023031144')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHltop(html('not-found').replace(/<font color=red size=4>9999000017<\/font>/gu, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHltop('<html><body>Server busy</body></html>', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHltop(html('delivered').replace(/<tr noWrap=top>.*?<\/tr>/gsu, ''), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseHltop(html('delivered').replace('2023-05-30 08:09:45', 'soon'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new HltopTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(bytes('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.hltop.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>document.cookie="srcurl=687474703a2f2f";location.href="/?security_verify_data=313932302c31303830"</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeHltopNumber(`${NUMBER} `)).toBe(NUMBER);
    for (const number of ['20230', 'HAILIAN', '2'.repeat(31), `${NUMBER},${UNKNOWN}`, '']) {
      expect(() => normalizeHltopNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HltopTracker({ fetcher }).fetch('2023&id=1')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new HltopTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hltop', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers Hailian for no number shape', () => {
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).candidates).not.toContain('hltop');
  });

  it('maps each text in statuses.json by its status word, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('运送中, 快件到达 某地中转场'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('派送中'))).toBe('out_for_delivery');
    expect(statusMap.stage(null, normalizeStatusWording('某地分拨中心 进行收件确认'))).toBe('registered');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(hltopStage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(hltopStage('新的状态')).toBeNull();
  });
});
