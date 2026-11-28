import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { statusGapNote, normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MORELINK_CAPTCHA, MORELINK_SEARCH, morelinkPage, MorelinkTracker, morelinkRefusedCode, normalizeMorelinkNumber,
  parseMorelink } from './adapter.js';
import { morelinkStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
// The invented number the not-found fixture was asked for.
const UNKNOWN = '314159265358979';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (name: string): unknown => JSON.parse(text(name));
const PICTURE = readFileSync(new URL('./fixtures/captcha-vhy5.jpg', import.meta.url));

/** The found reply with its rows changed. */
function withRows(change: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): unknown {
  const found = reply('found') as { data: string };
  const groups = JSON.parse(found.data) as { tb: Record<string, unknown>[] }[];
  return { ...found, data: JSON.stringify([{ tb: change(groups[0]!.tb) }]) };
}

/** A tracker that hands out pictures, each in a session of its own, and answers the search, accepting one code in either case. */
function site(options: { body?: string; accepted?: string; number?: string } = {}) {
  let session = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url), headers = new Headers(init?.headers);
    expect(headers.get('referer')).toBe(morelinkPage(options.number ?? SAMPLE));
    if (target.startsWith(`${MORELINK_CAPTCHA}?time=`)) {
      // A picture is asked without a cookie: it opens the session.
      expect(headers.get('cookie')).toBeNull();
      session += 1;
      const response = new Response(PICTURE, { headers: { 'Content-Type': 'image/jpeg', 'Set-Cookie': `ASP.NET_SessionId=synthetic${session}; path=/` } });
      // The cookie jar files a cookie under the address that answered.
      Object.defineProperty(response, 'url', { value: target });
      return response;
    }
    if (target === MORELINK_SEARCH && init?.method === 'POST') {
      expect(headers.get('cookie')).toBe(`ASP.NET_SessionId=synthetic${session}`);
      expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
      const form = new URLSearchParams(String(init.body));
      expect(form.get('strorderno')).toBe(options.number ?? SAMPLE);
      if (form.get('ordercode')?.toLowerCase() !== (options.accepted ?? 'vhy5')) return new Response(text('refused'));
      return new Response(options.body ?? text('found'), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    throw new Error(`unexpected request ${target}`);
  });
}

describe('MoreLink order numbers', () => {
  it('takes six to thirty letters and digits, without spaces or hyphens', () => {
    expect(normalizeMorelinkNumber(` ${SAMPLE.slice(0, 6)} ${SAMPLE.slice(6)} `)).toBe(SAMPLE);
    for (const other of ['81008', 'ABCDEFGHIJKLM', `${SAMPLE}<b>`, '1'.repeat(31)]) {
      expect(() => normalizeMorelinkNumber(other)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('leaves the fifteen bare digits to the carriers whose rules take them', () => {
    expect(detectCarrierMatch(SAMPLE).candidates).not.toContain('morelink56');
  });
});

describe('MoreLink order reply', () => {
  it('reads the sea freight rows, China\'s on its clock and the destination\'s on their wall clock, newest first', () => {
    const result = parseMorelink(reply('found'), SAMPLE, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '订单预受理 SO：810086200300213', last_update: null, last_update_local: '2020-03-17T14:42:02',
      expected_delivery: null, destination_country: 'JP' });
    // The destination rows carry no instant, so the delivery has none either.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.local_time, event.location, event.description, event.stage])).toEqual([
      [undefined, '2020-03-17T14:42:02', undefined, '订单预受理 SO：810086200300213', undefined],
      [undefined, '2020-03-15T11:34:01', undefined, '货物已签收', 'delivered'],
      [undefined, '2020-03-13T14:45:08', undefined, '已拆柜 预计3/14号交仓', 'in_transit'],
      [undefined, '2020-03-12T14:45:07', undefined, '货物清关已放行', 'in_transit'],
      [undefined, '2020-03-12T14:45:06', undefined, '目的港清关中', 'customs'],
      [undefined, '2020-03-11T14:45:05', undefined, '已到港', 'in_transit'],
      ['2020-03-08T14:45:04+08:00', '2020-03-08T14:45:04', undefined, '已开船 凌晨5点开船', 'in_transit'],
      ['2020-03-06T14:45:03+08:00', '2020-03-06T14:45:03', undefined, '出口报关已放行 船名航次：OOCL CHARLESTON 179N', 'in_transit'],
      ['2020-03-06T14:45:02+08:00', '2020-03-06T14:45:02', undefined, '出口查验', 'customs'],
      ['2020-03-06T14:45:01+08:00', '2020-03-06T14:45:01', undefined, '货物已装柜', 'in_transit'],
      ['2020-03-05T15:18:00+08:00', '2020-03-05T15:18:00', '深圳福永仓', '转运中心已收货 货物已抵达【深圳福永仓】', 'accepted'],
      ['2020-03-05T10:29:44+08:00', '2020-03-05T10:29:44', undefined, '您提交了订单，请等待系统受理', 'registered'],
    ]);
    expect(result.events!.filter((event) => event.time).every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/podfile|picture|https?:/);
  });

  it('dates a destination row on the destination\'s clock when it names a place there, and keeps a future row\'s wall clock', () => {
    const placed = withRows((rows) => rows.map((row) => (row.title === '已拆柜 预计3/14号交仓' ? { ...row, title: '已拆柜 【日本大阪】' } : row)));
    expect(parseMorelink(placed, SAMPLE, READ_AT).events![2]).toMatchObject({ time: '2020-03-13T14:45:08+09:00', time_zone: 'Asia/Tokyo',
      time_zone_basis: 'place', location: '日本大阪' });
    const future = withRows((rows) => rows.map((row) => (row.title === '货物已装柜 ' ? { ...row, routedate: '2027-03-06 14:45:01' } : row)));
    expect(parseMorelink(future, SAMPLE, READ_AT).events![0]).toMatchObject({ local_time: '2027-03-06T14:45:01', description: '货物已装柜' });
    expect(parseMorelink(future, SAMPLE, READ_AT).events![0]).not.toHaveProperty('time');
  });

  it('records each status word the reply showed, and the notice that moves nothing', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(`${entry.wording} 备注`);
      if (entry.stage) {
        expect(statusMap.stage(null, wording)).toBe(entry.stage);
        expect(morelinkStage(entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
      } else {
        expect(statusMap.stage(null, wording)).toBeUndefined();
        expect(statusGapNote(statusMap, null, wording)).toBe(entry.note);
        expect(morelinkStage(entry.wording)).toBeNull();
      }
    }
  });

  it('tells an unknown order, a refused code, another order and a changed reply apart', () => {
    expect(() => parseMorelink(reply('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMorelink(reply('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema', message: 'MoreLink answered for another number' }));
    expect(() => parseMorelink(reply('found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema', message: 'MoreLink answered for another number' }));
    const mixed = withRows((rows) => rows.map((row, index) => (index === 3 ? { ...row, sono: 'ZZ0000000000' } : row)));
    expect(() => parseMorelink(mixed, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema', message: 'MoreLink answered for another number' }));
    expect(morelinkRefusedCode(reply('refused'))).toBe('验证码不正确');
    expect(morelinkRefusedCode(reply('expired'))).toBe('验证码过期');
    expect(morelinkRefusedCode(reply('found'))).toBeNull();
    expect(morelinkRefusedCode(reply('not-found'))).toBeNull();
    expect(() => parseMorelink(reply('refused'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMorelink({ success: false, msg: '系统繁忙', data: '' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMorelink({ success: true, msg: 'ok', data: 'not json' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMorelink({ success: true, msg: 'ok', data: '[{"tb":[]}]' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMorelink('<html></html>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const badClock = withRows((rows) => rows.map((row, index) => (index === 2 ? { ...row, routedate: '2020-02-30 14:45:08' } : row)));
    expect(() => parseMorelink(badClock, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const noTitle = withRows((rows) => rows.map((row, index) => (index === 2 ? { ...row, title: null } : row)));
    expect(() => parseMorelink(noTitle, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('MoreLink tracker', () => {
  it('reads the code of the picture that opened the session, and posts the whole number with it', async () => {
    const fetcher = site();
    const tracker = new MorelinkTracker({ fetcher, userAgent: 'SyntheticHost/1.0', solveCaptcha: async () => 'vHY5' });
    const result = await tracker.fetch(SAMPLE);
    expect(result.events).toHaveLength(12);
    expect(fetcher.mock.calls.map(([url, init]) => [String(url).replace(/=\d+$/, '='), init?.method ?? 'GET'])).toEqual([
      [`${MORELINK_CAPTCHA}?time=`, 'GET'], [MORELINK_SEARCH, 'POST'],
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(new Headers(init?.headers).get('user-agent')).toBe('SyntheticHost/1.0');
    }
    await tracker.close();
  });

  it('takes a new picture in a new session after a refused code or an unreadable one, four pictures at most', async () => {
    const answers = ['vhy6', 'vh', 'VHY5'];
    const fetcher = site();
    const tracker = new MorelinkTracker({ fetcher, solveCaptcha: async () => answers.shift()! });
    await expect(tracker.fetch(SAMPLE)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(MORELINK_CAPTCHA))).toHaveLength(3);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === MORELINK_SEARCH)).toHaveLength(2);
    const refusing = site({ accepted: 'none' });
    const unsolved = new MorelinkTracker({ fetcher: refusing, solveCaptcha: async () => 'ab12' });
    await expect(unsolved.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'challenge', message: 'MoreLink verify code unsolved: 4 refused, 0 unread' });
    expect(refusing.mock.calls.filter(([url]) => String(url).startsWith(MORELINK_CAPTCHA))).toHaveLength(4);
    const expired = new MorelinkTracker({ fetcher: site({ body: text('expired') }), solveCaptcha: async () => 'vhy5' });
    await expect(expired.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'challenge', message: 'MoreLink verify code unsolved: 4 refused, 0 unread' });
    await Promise.all([tracker.close(), unsolved.close(), expired.close()]);
  });

  it('reports an unknown order as not found, a refused guest as a challenge and a page for JSON as a changed reply', async () => {
    const unknown = new MorelinkTracker({ fetcher: site({ body: text('not-found'), number: UNKNOWN }), solveCaptcha: async () => 'vhy5' });
    await expect(unknown.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    const blocked = new MorelinkTracker({ fetcher: vi.fn<typeof fetch>(async () => new Response('Forbidden', { status: 403 })), solveCaptcha: async () => 'vhy5' });
    await expect(blocked.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'challenge' });
    const moved = new MorelinkTracker({ fetcher: vi.fn<typeof fetch>(async () => new Response('', { status: 302, headers: { Location: '/' } })), solveCaptcha: async () => 'vhy5' });
    await expect(moved.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'transport' });
    const html = new MorelinkTracker({ fetcher: site({ body: '<html><body>Runtime Error</body></html>' }), solveCaptcha: async () => 'vhy5' });
    await expect(html.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'schema' });
    await Promise.all([unknown.close(), blocked.close(), moved.close(), html.close()]);
  });

  it('refuses a number the firm does not issue before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: 'ABC' }, {})).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
