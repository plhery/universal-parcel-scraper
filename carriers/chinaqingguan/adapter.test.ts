import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CHINAQINGGUAN_CAPTCHA, CHINAQINGGUAN_PAGE, CHINAQINGGUAN_SEARCH, ChinaqingguanTracker, chinaqingguanRefusedCode,
  normalizeChinaqingguanNumber, parseChinaqingguan } from './adapter.js';
import { chinaqingguanStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
// The invented number the not-found fixture was asked for.
const UNKNOWN = '2718281828459';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const PICTURE = readFileSync(new URL('./fixtures/captcha-5823.gif', import.meta.url));

/** A tracker that hands out pictures, each in a session of its own, and answers the form, accepting one code. */
function site(options: { page?: string; accepted?: string; number?: string } = {}) {
  let session = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url), headers = new Headers(init?.headers);
    expect(headers.get('referer')).toBe(CHINAQINGGUAN_PAGE);
    if (target === CHINAQINGGUAN_CAPTCHA) {
      // A picture is asked without a cookie: it opens the session.
      expect(headers.get('cookie')).toBeNull();
      session += 1;
      const response = new Response(PICTURE, { headers: { 'Content-Type': 'image/gif', 'Set-Cookie': `PHPSESSID=synthetic${session}; path=/` } });
      // The cookie jar files a cookie under the address that answered.
      Object.defineProperty(response, 'url', { value: target });
      return response;
    }
    if (target === CHINAQINGGUAN_SEARCH && init?.method === 'POST') {
      expect(headers.get('cookie')).toBe(`PHPSESSID=synthetic${session}`);
      expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init.body));
      expect(form.get('inputNumber')).toBe(options.number ?? SAMPLE);
      if (form.get('checkcode') !== (options.accepted ?? '5823')) return new Response(page('refused'));
      return new Response(options.page ?? page('found'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    throw new Error(`unexpected request ${target}`);
  });
}

describe('Rongtong International waybills', () => {
  it('takes twelve to thirty letters and digits, without spaces or hyphens', () => {
    expect(normalizeChinaqingguanNumber(` ${SAMPLE.slice(0, 6)} ${SAMPLE.slice(6)} `)).toBe(SAMPLE);
    for (const other of ['77900053754', 'ABCDEFGHIJKLM', `${SAMPLE}<b>`, '1'.repeat(31)]) {
      expect(() => normalizeChinaqingguanNumber(other)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('leaves the thirteen bare digits to the carriers whose rules take them', () => {
    expect(detectCarrierMatch(SAMPLE).candidates).not.toContain('chinaqingguan');
  });
});

describe('Rongtong International result page', () => {
  it('reads the clearance rows at Guangzhou Baiyun airport on China\'s clock, newest first', () => {
    const result = parseChinaqingguan(page('found'), SAMPLE, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '（个人物品）广州白云机场清关完毕，货物进入国内快递，荣通公司尽快将货物送到客户手上',
      last_update: '2021-06-26T22:03:00+08:00', last_update_local: '2021-06-26T22:03:00', expected_delivery: null, destination_country: 'CN' });
    // The page hands the parcel to the firm itself, or a partner it does not name, under the same number.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events!.map((event) => [event.time, event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2021-06-26T22:03:00+08:00', '2021-06-26T22:03:00', '广州白云机场', '（个人物品）广州白云机场清关完毕，货物进入国内快递，荣通公司尽快将货物送到客户手上', 'in_transit'],
      ['2021-06-26T14:30:00+08:00', '2021-06-26T14:30:00', '广州白云机场', '（个人物品）广州白云机场已清关', 'in_transit'],
      ['2021-06-23T02:14:00+08:00', '2021-06-23T02:14:00', '广州白云机场', '（个人物品）广州白云机场已送海关、排队待通关', 'customs'],
      ['2021-06-21T17:56:00+08:00', '2021-06-21T17:56:00', '广州白云机场', '（个人物品）广州白云机场已送仓库', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier')).toBe(true);
  });

  it('hands the parcel on to a courier the line names when that courier\'s rules take the number', () => {
    const sf = 'SF1405123456789';
    expect(detectCarrierMatch(sf).candidates).toContain('sf-express');
    const handed = page('found').replace('荣通国际货运（或合作伙伴）', '顺丰速运')
      .replace(`<strong style="font-size: 14px;color: green;">${SAMPLE}</strong>`, `<strong style="font-size: 14px;color: green;">${sf}</strong>`);
    expect(parseChinaqingguan(handed, SAMPLE, READ_AT)).toMatchObject({ delivery_carrier: 'sf-express', delivery_tracking_number: sf });
    // A courier whose rules do not take the number is no hand-off.
    expect(parseChinaqingguan(page('found').replace('荣通国际货运（或合作伙伴）', '顺丰速运'), SAMPLE, READ_AT)).not.toHaveProperty('delivery_carrier');
  });

  it('reads a domestic row above the separator without the courier\'s phone, and dates a future row by its wall clock alone', () => {
    const domestic = page('found').replace('<td>NULL</td>', '<td>2021.06.28 09:12</td>')
      .replace('查询无结果，请隔段时间再查', '【广州市】快件已签收，如有疑问请联系派件员13800000000');
    const result = parseChinaqingguan(domestic, SAMPLE, READ_AT);
    expect(result.events![0]).toMatchObject({ local_time: '2021-06-28T09:12:00', description: '【广州市】快件已签收', stage: 'delivered' });
    expect(JSON.stringify(result)).not.toContain('13800000000');
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2021-06-28T09:12:00+08:00' });
    const future = parseChinaqingguan(page('found').replace('2021.06.26 22:03', '2027.06.26 22:03'), SAMPLE, READ_AT);
    expect(future.events![0]).toMatchObject({ local_time: '2027-06-26T22:03:00' });
    expect(future.events![0]).not.toHaveProperty('time');
  });

  it('records each text the page showed with a stage', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
      expect(chinaqingguanStage(entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('tells an unknown waybill, a refused code, another waybill, a browser check and a changed page apart', () => {
    expect(() => parseChinaqingguan(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseChinaqingguan(page('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Rongtong International answered for another number' }));
    expect(() => parseChinaqingguan(page('found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Rongtong International answered for another number' }));
    expect(chinaqingguanRefusedCode(page('refused'))).toBe(true);
    expect(chinaqingguanRefusedCode(page('found'))).toBe(false);
    expect(() => parseChinaqingguan(page('refused'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChinaqingguan('<html><head><title>安全验证</title></head><body></body></html>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseChinaqingguan('<html><body>Service Unavailable</body></html>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChinaqingguan(page('found').replace('2021.06.23 02:14', '2021.02.30 02:14'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChinaqingguan(page('found').replace('2021.06.23 02:14', 'yesterday'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = page('found').replace(/<tr>\s*<td>\d{4}\.[\s\S]*?<\/tr>/g, '');
    expect(() => parseChinaqingguan(empty, SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });
});

describe('Rongtong International tracker', () => {
  it('reads the code of the picture that opened the session, and posts the whole number with it', async () => {
    const fetcher = site();
    const tracker = new ChinaqingguanTracker({ fetcher, userAgent: 'SyntheticHost/1.0', solveCaptcha: async () => '5823' });
    const result = await tracker.fetch(SAMPLE);
    expect(result.events).toHaveLength(4);
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      [CHINAQINGGUAN_CAPTCHA, 'GET'], [CHINAQINGGUAN_SEARCH, 'POST'],
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(new Headers(init?.headers).get('user-agent')).toBe('SyntheticHost/1.0');
    }
    await tracker.close();
  });

  it('takes a new picture in a new session after a refused code or an unreadable one, four pictures at most', async () => {
    const answers = ['5828', '58Z3', '5823'];
    const fetcher = site();
    const tracker = new ChinaqingguanTracker({ fetcher, solveCaptcha: async () => answers.shift()! });
    await expect(tracker.fetch(SAMPLE)).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === CHINAQINGGUAN_CAPTCHA)).toHaveLength(3);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === CHINAQINGGUAN_SEARCH)).toHaveLength(2);
    const refusing = site({ accepted: 'none' });
    const unsolved = new ChinaqingguanTracker({ fetcher: refusing, solveCaptcha: async () => '1234' });
    await expect(unsolved.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'challenge', message: 'Rongtong International verify code unsolved: 4 refused, 0 unread' });
    expect(refusing.mock.calls.filter(([url]) => String(url) === CHINAQINGGUAN_CAPTCHA)).toHaveLength(4);
    await Promise.all([tracker.close(), unsolved.close()]);
  });

  it('reports an unknown waybill as not found, and a refused guest as a challenge', async () => {
    const unknown = new ChinaqingguanTracker({ fetcher: site({ page: page('not-found'), number: UNKNOWN }), solveCaptcha: async () => '5823' });
    await expect(unknown.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    const blocked = new ChinaqingguanTracker({ fetcher: vi.fn<typeof fetch>(async () => new Response('Forbidden', { status: 403 })), solveCaptcha: async () => '5823' });
    await expect(blocked.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'challenge' });
    const moved = new ChinaqingguanTracker({ fetcher: vi.fn<typeof fetch>(async () => new Response('', { status: 302, headers: { Location: '/' } })), solveCaptcha: async () => '5823' });
    await expect(moved.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'transport' });
    await Promise.all([unknown.close(), blocked.close(), moved.close()]);
  });

  it('refuses a number the firm does not issue before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: 'ABC' }, {})).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
