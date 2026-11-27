import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, QUNHANG_TRACK, QunhangTracker, qunhangLookupUrl } from './adapter.js';
import { normalizeQunhangNumber, parseQunhang, qunhangText } from './parser.js';
import { qunhangStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'YT0001582039471';
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Name = 'delivered' | 'not-found';
const page = (name: Name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' }, ...init });

describe('Qunhang tracking lookup', () => {
  it('asks the tracking fragment for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const typed = `${NUMBER.slice(0, 6).toLowerCase()} ${NUMBER.slice(6)}`;
    const result = await new QunhangTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(typed, { budgetMs: 5000 });
    expect(result.events).toHaveLength(14);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(qunhangLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(QUNHANG_TRACK);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ oids: NUMBER });
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cloudlogistics365', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first on China\'s clock, with clearance in Tianjin and YTO delivering under the same waybill', () => {
    const result = parseQunhang(page('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已领取，收件人在[代收点](某某苑快递点)取件', last_update: '2026-11-08T12:23:17+08:00',
      last_update_local: '2026-11-08T12:23:17', delivered_at: '2026-11-08T12:23:17+08:00', expected_delivery: null,
      origin_country: 'JP', destination_country: 'CN', delivery_carrier: 'yto', delivery_tracking_number: NUMBER });
    const events = result.events!;
    expect(events.map((event) => [event.description, event.location ?? null, event.stage])).toEqual([
      ['您的快件已领取，收件人在[代收点](某某苑快递点)取件', null, 'delivered'],
      ['您的快件已到达[代收点](某某苑快递点)，请及时取件', null, 'ready_for_pickup'],
      ['【江西省宜春市袁州区湖田镇】正在为您派件', '江西省宜春市袁州区湖田镇', 'out_for_delivery'],
      ['您的快件已经到达【江西省宜春市】', '江西省宜春市', 'in_transit'],
      ['您的快件离开【南昌转运中心】，已发往【江西省宜春市】', '南昌转运中心', 'in_transit'],
      ['您的快件已经到达【南昌转运中心】', '南昌转运中心', 'in_transit'],
      ['您的快件离开【天津转运中心】，已发往【南昌转运中心】', '天津转运中心', 'in_transit'],
      ['您的快件已经到达【天津转运中心】', '天津转运中心', 'in_transit'],
      ['您的快件离开【天津市河东区太阳城】，已发往【天津转运中心】', '天津市河东区太阳城', 'in_transit'],
      ['您的快件在【天津市河东区太阳城】已揽收', '天津市河东区太阳城', 'in_transit'],
      ['清关完成，进入国内物流环节，请您耐心等候', null, 'in_transit'],
      ['审验完毕海关放行', '天津滨海国际机场/TSN(CN)', 'in_transit'],
      ['正在办理清关手续', null, 'customs'],
      ['国际运输环节中', null, 'in_transit'],
    ]);
    expect(events.at(-1)).toEqual({ time: '2026-10-22T12:54:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2026-10-22T12:54:00', description: '国际运输环节中', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events[11]).toMatchObject({ original_description: '审验完毕海关放行 中国天津滨海国际机场/TSN(CN)' });
    expect(JSON.stringify(result)).not.toMatch(/\*|13800000000|02200000000|联系|电话|致电|某小区|揽收人/);
  });

  it('takes the operator\'s contact, couriers, phones and the pickup point\'s address out of a row\'s text', () => {
    expect(qunhangText('国际运输环节中，具体情况可联系快件运营人：天津群航、联系人：***、电话：13800000000。海关对外咨询电话02200000000'))
      .toBe('国际运输环节中');
    expect(qunhangText('您的快件在【天津市河东区太阳城】已揽收，揽收人: ***（13800000000）【物流问题请致电（专属热线:95554）更快解决】'))
      .toBe('您的快件在【天津市河东区太阳城】已揽收');
    expect(qunhangText('【江西省宜春市袁州区湖田镇】的***（13800000000）正在为您派件（95161和18521号段的上海号码为圆通快递员专属号码）'))
      .toBe('【江西省宜春市袁州区湖田镇】正在为您派件');
    expect(qunhangText('您的快件已到达[代收点](某某苑快递点)某小区某栋中国邮政，请及时取件，如有取件码问题，请联系站点：13800000000'))
      .toBe('您的快件已到达[代收点](某某苑快递点)，请及时取件');
    expect(qunhangText('您的快件离开【天津转运中心】，已发往【南昌转运中心】。预计【11月03日】到达【南昌市】，请您放心！'))
      .toBe('您的快件离开【天津转运中心】，已发往【南昌转运中心】');
    expect(qunhangText('请致电 13800000000')).toBe('请致电');
  });

  it('names no delivery carrier for a number YTO\'s rules do not take', () => {
    const other = 'QH20261022001';
    const result = parseQunhang(page('delivered').replaceAll(NUMBER, other), other, READ_AT);
    expect(result).toMatchObject({ destination_country: 'CN', origin_country: 'JP' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseQunhang(page('delivered'), NUMBER, Date.parse('2026-11-08T04:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2026-11-04T14:20:25+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-11-08T12:23:17' });
  });

  it('reads the empty fragment as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseQunhang(page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseQunhang(page('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQunhang(page('not-found').replace(/<div class="accordion"[^>]*>/u, '$&<p>系统繁忙</p>'), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = page('delivered').replace(/<ul>[\s\S]*<\/ul>/u, '<ul></ul>');
    expect(() => parseQunhang(empty, NUMBER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = page('delivered').replace('2026-11-08 12:23:17', '2026-11-31 12:23:17');
    expect(() => parseQunhang(clock, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new QunhangTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('not-found'), { status: 500 })).rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://z.cloudlogistics365.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeQunhangNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['12345', 'YTABCDEFGH', `Y${'1'.repeat(30)}`, 'YT2554/632210988', '']) {
      expect(() => normalizeQunhangNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new QunhangTracker({ fetcher }).fetch('YT1&oids=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new QunhangTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'cloudlogistics365', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('leaves YTO\'s waybill to YTO', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'yto' });
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('cloudlogistics365');
  });

  it('maps each text by its form in statuses.json, with places and the pickup point as …, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('您的快件已经到达【北京转运中心】'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('您的快件已到达[代收点](某驿站)，请及时取件'))).toBe('ready_for_pickup');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(qunhangStage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(qunhangStage('新的状态')).toBeNull();
  });
});
