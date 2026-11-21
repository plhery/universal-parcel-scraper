import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, goodTrackingUrl } from './adapter.js';
import { normalizeGoodNumber, parseGood } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// Replies to public samples; the tests derive invented parcels from them.
const SAMPLE = 'GD66102101222US';
const FORGOTTEN = 'GD64110500516US';
const INVENTED = 'GD66139900017US';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, text: string) => `<tr>\n<td class="left-label">${clock}</td>\n<td class="text-start">${text}</td>\n</tr>`;
/** The public sample's page with rows put before its newest. */
const withNewer = (...rows: string[]) => fixture(SAMPLE).replace(/(<table class="table table-borderless h6 text-start">)/, `$1${rows.join('')}`);
/** The public sample's page with only these rows. */
const withRows = (...rows: string[]) => fixture(SAMPLE).replace(/(<table class="table table-borderless h6 text-start">)[\s\S]*?(<\/table>)/, `$1${rows.join('')}$2`);

describe('GOOD Express numbers', () => {
  it('takes GD, eleven digits and US', () => {
    expect(normalizeGoodNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeGoodNumber('gd60032500427us')).toBe('GD60032500427US');
    for (const other of ['', 'GD6610210122US', 'GD661021012222US', 'GD66102101222CN', 'GE66102101222US', '66102101222', 'X'.repeat(70)]) {
      expect(() => normalizeGoodNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('GOOD Express tracking adapter', () => {
  it('asks the tracker’s page for the waybill over HTTPS', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(SAMPLE)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.goodkuaidi.com/TrackingInfo?TrackginNO=GD66102101222US');
    expect(goodTrackingUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'good-express-us', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number GOOD does not issue without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'GD123US' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).recognize!('GD123US')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the tracker’s one "无跟踪信息" row as not found, and recognizes a waybill with rows', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(unknown).track({ number: FORGOTTEN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(unknown).recognize!(FORGOTTEN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(SAMPLE)));
    await expect(carrier(known).recognize!(SAMPLE)).resolves.toEqual({ known: true, lastActivityAt: '2026-11-21T21:30:21.000Z' });
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing waybill', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Runtime Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Service Unavailable</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/Error' } }))).toMatchObject({ kind: 'transport' });
  });
});

describe('GOOD Express pages', () => {
  it('reads the public sample: rows on China time, the country moved to the location, the courier in China', () => {
    const result = parseGood(fixture(SAMPLE), SAMPLE);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '快件在【西安沣东转运中心】完成分拣，准备发往 【天津通年转运中心】',
      last_update: '2026-11-22T05:30:21+08:00', expected_delivery: null,
      delivery_carrier: 'sf-express', delivery_tracking_number: '587056104998',
    });
    expect(result.events).toHaveLength(19);
    expect(result.events!.find((event) => event.description!.startsWith('快递公司'))).toEqual({
      time: '2026-11-20T17:31:21+08:00', description: '快递公司Dispatching delivery：顺丰速运,单号： 587056104998', location: 'China',
      original_description: '【中国CHN】快递公司Dispatching delivery：顺丰速运,单号： 587056104998', stage: 'in_transit', stage_source: 'carrier_map',
    });
    expect(result.events!.at(-1)).toEqual({
      time: '2026-10-21T14:42:33+08:00', description: '商家已拣货打包，待发往GOOD快递站点【Label created】', location: 'United States',
      original_description: '【美国US】商家已拣货打包，待发往GOOD快递站点【Label created】', stage: 'registered', stage_source: 'carrier_map',
    });
    // The request for the recipient's identity card moves nothing; every other row has a stage from the map.
    expect(result.events!.at(-2)).toEqual({ time: '2026-10-21T14:43:33+08:00', description: '请【 上传身份证 】【Please uploade identification】' });
    expect(result.events!.filter((event) => event.stage_source !== 'carrier_map')).toHaveLength(1);
    expect(result.events!.find((event) => event.description!.startsWith('【航空'))).not.toHaveProperty('location');
    expect(result.events!.map((event) => event.stage)).toContain('customs');
  });

  it('reads a delivery in China by the shared wording rules, and a waybill whose newest row is the identity-card request', () => {
    const delivered = parseGood(withNewer(row('2026/11/23 9:05:12', '快件已签收，签收人：本人')), SAMPLE);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language', last_update: '2026-11-23T09:05:12+08:00' });
    const early = parseGood(withRows(row('2026/10/21 14:43:33', "请【<a href='/UploadIDPic?YUNDAN_CODE=GD66102101222US'>上传身份证</a>】【Please uploade identification】"),
      row('2026/10/21 14:42:33', '【美国US】商家已拣货打包，待发往GOOD快递站点【Label created】')), SAMPLE);
    expect(early).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: '请【 上传身份证 】【Please uploade identification】' });
    expect(early).not.toHaveProperty('delivery_tracking_number');
  });

  it('names the courier in China only when its rules offer the number', () => {
    const handoff = (courier: string, number: string) => withRows(row('2026/11/20 17:31:21',
      `【中国CHN】快递公司Dispatching delivery：${courier},单号：<a href="https://example.com/?${number}" target=_blank>${number}</a>`));
    expect(parseGood(handoff('中国邮政EMS', 'EX000000017CN'), SAMPLE)).toMatchObject({ delivery_tracking_number: 'EX000000017CN', current_stage: 'in_transit' });
    expect(parseGood(handoff('中国邮政EMS', 'EX000000017CN'), SAMPLE)).not.toHaveProperty('delivery_carrier');
    expect(parseGood(handoff('顺丰速运', 'AB12'), SAMPLE)).not.toHaveProperty('delivery_carrier');
  });

  it('refuses a page for another waybill, and a changed page', () => {
    expect(() => parseGood(fixture(SAMPLE), INVENTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const page of [
      withRows(row('2026/13/22 4:25:00', '快件到达 【西安沣东转运中心】')),
      withRows(row('2026/11/22 24:25:00', '快件到达 【西安沣东转运中心】')),
      withRows(row('22/11/2026 4:25', '快件到达 【西安沣东转运中心】')),
      withRows(row('2026/11/22 4:25:00', '')),
      withRows(row('2026/11/22 4:25:00', '无跟踪信息'), row('2026/11/21 4:25:00', '快件到达 【西安沣东转运中心】')),
      withRows('<tr><td>2026/11/22 4:25:00</td><td>快件到达</td></tr>'),
      withRows(),
      fixture(SAMPLE).replace('运单号：', '单号：'),
    ]) expect(() => parseGood(page, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('answers each wording statuses.json records by its stage, or as a gap', () => {
    for (const { wording, stage } of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMapAnswer({ carrier: 'good-express-us', providerCode: null, description: wording }), wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage/) });
    }
    // SF's rows name other depots, and the hand-off other couriers and numbers.
    for (const wording of ['快件到达 【北京顺义集散中心】', '快递公司Dispatching delivery：中国邮政EMS,单号： EX000000017CN']) {
      expect(statusMapAnswer({ carrier: 'good-express-us', providerCode: null, description: normalizeStatusWording(wording) })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // A delivery is left to the shared rules.
    expect(statusMapAnswer({ carrier: 'good-express-us', providerCode: null, description: '快件已签收，签收人：本人' })).toEqual({ kind: 'unknown' });
  });
});
