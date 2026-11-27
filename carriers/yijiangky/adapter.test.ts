import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YIJIANG_TRACKER, YijiangTracker, yijiangLookupUrl } from './adapter.js';
import { normalizeYijiangNumber, parseYijiang, yijiangText } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample, and the invented number of the not-found fixture.
const SAMPLE = 'YJ362260506067';
const INVENTED = 'YJ100200300400';
// After the sample's newest row.
const READ_AT = Date.parse('2026-11-27T20:54:40Z');

const raw = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
interface Detail { context: string; location?: string; time: string }
/** The sample's reply with its details replaced. */
const withDetails = (...details: Detail[]) => {
  const reply = JSON.parse(raw('delivered')) as { data: { details: Detail[] }[] };
  reply.data[0]!.details = details;
  return JSON.stringify(reply);
};
const parse = (body: string, number = SAMPLE) => parseYijiang(body, number, READ_AT);

describe('Yijiang Express numbers', () => {
  it('takes 6 to 30 letters and digits, with a digit', () => {
    expect(normalizeYijiangNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeYijiangNumber('YJ3622-6050-6067')).toBe(SAMPLE);
    for (const other of ['', 'YJ12', 'YJABCDEFGH', `${SAMPLE},${INVENTED}`, 'Y'.repeat(31), 'X'.repeat(70)]) {
      expect(() => normalizeYijiangNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Yijiang Express tracking lookup', () => {
  it('posts the page’s form for the whole number, over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/^http:\/\/www\.yijiangky\.com\/query\.aspx\?pID=3&v=0\.\d+$/);
    expect(yijiangLookupUrl(0.5)).toBe(`${YIJIANG_TRACKER}&v=0.5`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: YIJIANG_TRACKER,
    }) });
    expect(String(init!.body)).toContain('txtData%5Btxtnumbers%5D=YJ362260506067');
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({
      _action: 'query', txtIsNumber: '1', 'txtData[txtnumbers]': SAMPLE, 'txtData[txtphone]': '', key: 'yijiangky', secret: 'yijiangkycom', // gitleaks:allow
    });
    expect(carrier(fetcher)).toMatchObject({ id: 'yijiangky', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number the form cannot take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'YJ12' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).recognize!('YJ12')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads "查无结果" as not found, and recognizes a waybill with rows', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => response(raw('not-found')));
    await expect(carrier(unknown).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(unknown).recognize!(INVENTED)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockImplementation(async () => response(raw('delivered')));
    await expect(carrier(known).recognize!(SAMPLE)).resolves.toEqual({ known: true, finished: true, lastActivityAt: '2026-05-11T02:02:36.000Z' });
  });

  it('keeps refusals, verification pages, changed replies and redirects apart from a missing waybill', async () => {
    const answer = async (make: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => make()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => response('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => response('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => response('<html><body>Service Unavailable</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => response('', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/index.aspx' } }))).toMatchObject({ kind: 'transport' });
    // A wrong key, or a reply that is not the lookup's.
    expect(await answer(() => response('{"code":"1","msg":"key error"}'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => response('{"result":"true","message":"请输入单号"}'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => response('{"result":"true","message":"查无结果","data":[{"num":"YJ362260506067"}]}'))).toMatchObject({ kind: 'schema' });
  });

  it('retries only a request that fails to reach the site', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('delivered')));
    await expect(new YijiangTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

describe('Yijiang Express replies', () => {
  it('reads the sample newest first, each wall clock dated on China’s clock, each row at its city', () => {
    const result = parse(raw('delivered'));
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已签收，如有疑问请联系客服400 116 9596（总件数：1件）',
      last_update: '2026-05-11T10:02:36+08:00', last_update_local: '2026-05-11T10:02:36', expected_delivery: null,
    });
    expect(result.events).toHaveLength(13);
    expect(result.events![1]).toEqual({
      time: '2026-05-10T15:17:07+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2026-05-10T15:17:07',
      description: '快件交给派送员,正在派送途中，请耐心等待（总件数：1件）', location: '黑河市', stage: 'out_for_delivery', stage_source: 'carrier_map',
    });
    expect(result.events!.at(-1)).toEqual({
      time: '2026-05-06T14:29:44+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2026-05-06T14:29:44',
      description: '已收取快件', location: '银川市', stage: 'accepted', stage_source: 'carrier_map',
    });
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps rows of one second in the reply’s order, drops a repeated row, and leaves a row after the lookup its wall clock', () => {
    const result = parse(withDetails(
      { context: '快件已发车', location: '哈尔滨市', time: '2026-05-09 18:30:39' },
      { context: '快件在【哈尔滨分拨中心】完成分拣,准备发往黑河市北安市', location: '哈尔滨市', time: '2026-05-09 18:30:39' },
      { context: '快件已发车', location: '哈尔滨市', time: '2026-05-09 18:30:39' },
    ));
    expect(result.events!.map((event) => event.description)).toEqual(['快件已发车', '快件在【哈尔滨分拨中心】完成分拣,准备发往黑河市北安市']);
    const ahead = parse(withDetails({ context: '快件到达【银川转运中心】', location: '银川市', time: '2026-11-28 09:00:00' },
      { context: '已收取快件', location: '', time: '2026-11-27 14:29:44' }));
    expect(ahead).toMatchObject({ last_update: null, last_update_local: '2026-11-28T09:00:00' });
    expect(ahead.events![0]).not.toHaveProperty('time');
    expect(ahead.events![1]).toMatchObject({ time: '2026-11-27T14:29:44+08:00' });
    expect(ahead.events![1]).not.toHaveProperty('location');
  });

  it('takes the people a row names and phone numbers out, and keeps the firm’s service line and a waybill', () => {
    expect(yijiangText('快件交给派送员,正在派送途中，请耐心等待（总件数：1件）')).toBe('快件交给派送员,正在派送途中，请耐心等待（总件数：1件）');
    expect(yijiangText('快件交给派送员张三,正在派送途中，电话：13900001111')).toBe('快件交给派送员,正在派送途中');
    expect(yijiangText('【黑河北安部】的派件员【李四】正在派件')).toBe('【黑河北安部】的派件员正在派件');
    expect(yijiangText('派送员王五正在派件')).toBe('派送员正在派件');
    expect(yijiangText('派送员赵六（13900001111）正在派件')).toBe('派送员正在派件');
    expect(yijiangText('您的快件已签收，签收人：本人')).toBe('您的快件已签收');
    expect(yijiangText('您的快件已签收，如有疑问请联系客服400 116 9596')).toBe('您的快件已签收，如有疑问请联系客服400 116 9596');
    expect(yijiangText('快件转寄，单号：YJ100200300400')).toBe('快件转寄，单号：YJ100200300400');
    const result = parse(withDetails({ context: '签收人：张三', location: '黑河市', time: '2026-05-11 10:02:36' },
      { context: '已收取快件', location: '银川市', time: '2026-05-06 14:29:44' }));
    expect(result.events).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('张三');
  });

  it('refuses a reply for another waybill, and a changed reply', () => {
    expect(() => parse(raw('delivered'), INVENTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = JSON.parse(raw('delivered')) as { data: unknown[] };
    twice.data.push(twice.data[0]);
    for (const body of [
      JSON.stringify(twice),
      withDetails(),
      withDetails({ context: '快件已发车', location: '银川市', time: '2026-13-07 10:00:45' }),
      withDetails({ context: '快件已发车', location: '银川市', time: '2026-05-07 24:00:45' }),
      withDetails({ context: '快件已发车', location: '银川市', time: '07/05/2026 10:00' }),
      withDetails({ location: '银川市', time: '2026-05-07 10:00:45' } as Detail),
      withDetails({ context: '', location: '银川市', time: '2026-05-07 10:00:45' }),
      raw('delivered').replace('"SUCCESS"', '"OK"'),
      raw('delivered').replace('"result":"true"', '"result":"false"'),
    ]) expect(() => parse(body)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('answers each wording statuses.json records by its stage, whatever depot, town or count it names', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'yijiangky', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    for (const [wording, stage] of [
      ['快件在【福州分拨中心】完成分拣,准备发往【广州转运中心】', 'in_transit'],
      ['快件到达【广州转运中心】', 'in_transit'],
      ['快件到达福州市长乐区', 'in_transit'],
      ['快件分配到【福州长乐部】准备派件', 'in_transit'],
      ['快件交给派送员,正在派送途中，请耐心等待（总件数：12件）', 'out_for_delivery'],
      ['您的快件已签收，如有疑问请联系客服400 116 9596（总件数：4件）', 'delivered'],
    ] as const) expect(statusMapAnswer({ carrier: 'yijiangky', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
  });
});
