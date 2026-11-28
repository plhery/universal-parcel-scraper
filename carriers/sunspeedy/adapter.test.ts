import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, normalizeSunspeedyNumber, parseSunspeedy, SUNSPEEDY_CAPTCHA, SUNSPEEDY_PAGE, SUNSPEEDY_SEARCH, SunspeedyTracker,
  sunspeedyRefusedCode } from './adapter.js';
import { statusMap, sunspeedyStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
// The invented number the not-found fixture was asked for.
const UNKNOWN = 'ZZ314159265HK';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const PICTURE = readFileSync(new URL('./fixtures/captcha-7191.png', import.meta.url));

/** A tracker that hands out pictures, each in a session of its own, and answers the form, accepting one code. */
function site(options: { page?: string; accepted?: string; number?: string } = {}) {
  let session = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url), headers = new Headers(init?.headers);
    expect(headers.get('referer')).toBe(SUNSPEEDY_PAGE);
    if (target === SUNSPEEDY_CAPTCHA) {
      // A picture is asked without a cookie: it opens the session.
      expect(headers.get('cookie')).toBeNull();
      session += 1;
      const response = new Response(PICTURE, { headers: { 'Content-Type': 'image/png', 'Set-Cookie': `ci_session=synthetic${session}; path=/` } });
      // The cookie jar files a cookie under the address that answered.
      Object.defineProperty(response, 'url', { value: target });
      return response;
    }
    if (target === SUNSPEEDY_SEARCH && init?.method === 'POST') {
      expect(headers.get('cookie')).toBe(`ci_session=synthetic${session}`);
      expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init.body));
      expect(form.get('delivery_id')).toBe(options.number ?? SAMPLE);
      expect(form.get('submit')).toBe('提交');
      if (form.get('delivery_captcha') !== (options.accepted ?? '7191')) return new Response(page('refused'));
      return new Response(options.page ?? page('found'), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
    }
    throw new Error(`unexpected request ${target}`);
  });
}

describe('Sunspeedy waybills', () => {
  it('takes eight to thirty letters and digits, without spaces or hyphens', () => {
    expect(normalizeSunspeedyNumber(` ${SAMPLE.slice(0, 6).toLowerCase()} ${SAMPLE.slice(6)} `)).toBe(SAMPLE);
    for (const other of ['PL61960', 'ABCDEFGHIJKLM', `${SAMPLE}<b>`, '1'.repeat(31)]) {
      expect(() => normalizeSunspeedyNumber(other)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('leaves the post\'s letters-digits-CN shape to detection\'s other rules', () => {
    expect(detectCarrierMatch(SAMPLE).candidates).not.toContain('sunspeedy');
  });
});

describe('Sunspeedy result page', () => {
  it('dates the rows that name a Polish place on Poland\'s clock and keeps the others\' wall clock, newest first', () => {
    const result = parseSunspeedy(page('found'), SAMPLE, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '已過機,安排出庫', last_update: null, last_update_local: '2016-08-16T06:45:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.local_time, event.location, event.description, event.stage])).toEqual([
      [undefined, '2016-08-16T06:45:00', undefined, '已過機,安排出庫', 'in_transit'],
      [undefined, '2016-08-14T21:44:00', undefined, '包裹拆封分派', 'in_transit'],
      ['2016-08-14T03:14:00+02:00', '2016-08-14T03:14:00', 'Warszawa', '包裹已到達Warszawa境外包裹中轉中心', 'in_transit'],
      ['2016-08-12T19:48:00+02:00', '2016-08-12T19:48:00', 'Legionowo', 'Legionowo已收件,安排至Warszawa境外包裹中轉中心', 'in_transit'],
      [undefined, '2016-08-12T01:42:00', undefined, '包裹已入庫,裝箱掃瞄', 'accepted'],
    ]);
    expect(result.events!.filter((event) => event.time).every((event) => event.time_zone === 'Europe/Warsaw' && event.time_zone_basis === 'place')).toBe(true);
    expect(result).not.toHaveProperty('destination_country');
  });

  it('takes the zone of a country a row names, and keeps the wall clock of a row whose places disagree or lie ahead', () => {
    const country = parseSunspeedy(page('found').replace('(包裹拆封分派)', '(包裹已到達Hungary)'), SAMPLE, READ_AT);
    expect(country.events![1]).toMatchObject({ time: '2016-08-14T21:44:00+02:00', time_zone: 'Europe/Budapest', location: 'Hungary' });
    const mixed = parseSunspeedy(page('found').replace('(包裹拆封分派)', '(Warszawa發往Hungary)'), SAMPLE, READ_AT);
    expect(mixed.events![1]).not.toHaveProperty('time');
    expect(mixed.events![1]).not.toHaveProperty('location');
    const future = parseSunspeedy(page('found').replace('2016-08-14 03:14', '2027-08-14 03:14'), SAMPLE, READ_AT);
    expect(future.events!.find((event) => event.local_time === '2027-08-14T03:14:00')).not.toHaveProperty('time');
  });

  it('records each text the page showed with a stage', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
      expect(sunspeedyStage(entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('tells an unknown waybill, a refused code, another waybill, a browser check and a changed page apart', () => {
    expect(() => parseSunspeedy(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSunspeedy(page('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Sunspeedy answered for another number' }));
    expect(() => parseSunspeedy(page('found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Sunspeedy answered for another number' }));
    // The result line must name the number the form kept.
    const other = page('found').replace(`運單號:${SAMPLE}結果`, '運單號:ZZ000000000HK結果');
    expect(() => parseSunspeedy(other, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Sunspeedy answered for another number' }));
    expect(sunspeedyRefusedCode(page('refused'))).toBe(true);
    expect(sunspeedyRefusedCode(page('found'))).toBe(false);
    expect(sunspeedyRefusedCode(page('not-found'))).toBe(false);
    expect(() => parseSunspeedy(page('refused'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSunspeedy('<html><head><title>安全验证</title></head><body></body></html>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSunspeedy('<html><body>Service Unavailable</body></html>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSunspeedy(page('found').replace('2016-08-14 03:14', '2016-02-30 03:14'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSunspeedy(page('found').replace('2016-08-14 03:14', 'yesterday'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = page('found').replace(/<tr>\s*<td>\d{4}-[\s\S]*?<\/tr>/g, '');
    expect(() => parseSunspeedy(empty, SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });
});

describe('Sunspeedy tracker', () => {
  it('reads the code of the picture that opened the session, and posts the whole number with it', async () => {
    const fetcher = site();
    const tracker = new SunspeedyTracker({ fetcher, userAgent: 'SyntheticHost/1.0', solveCaptcha: async () => '7191' });
    const result = await tracker.fetch(SAMPLE);
    expect(result.events).toHaveLength(5);
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      [SUNSPEEDY_CAPTCHA, 'GET'], [SUNSPEEDY_SEARCH, 'POST'],
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(new Headers(init?.headers).get('user-agent')).toBe('SyntheticHost/1.0');
    }
    await tracker.close();
  });

  it('takes a new picture in a new session after a refused code or an unreadable one, three pictures at most', async () => {
    const answers = ['7181', '71g1', '7191'];
    const fetcher = site();
    const tracker = new SunspeedyTracker({ fetcher, solveCaptcha: async () => answers.shift()! });
    await expect(tracker.fetch(SAMPLE)).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === SUNSPEEDY_CAPTCHA)).toHaveLength(3);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === SUNSPEEDY_SEARCH)).toHaveLength(2);
    const refusing = site({ accepted: 'none' });
    const unsolved = new SunspeedyTracker({ fetcher: refusing, solveCaptcha: async () => '1234' });
    await expect(unsolved.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'challenge', message: 'Sunspeedy verify code unsolved: 3 refused, 0 unread' });
    expect(refusing.mock.calls.filter(([url]) => String(url) === SUNSPEEDY_CAPTCHA)).toHaveLength(3);
    await Promise.all([tracker.close(), unsolved.close()]);
  });

  it('reports an unknown waybill as not found, and a refused guest as a challenge', async () => {
    const unknown = new SunspeedyTracker({ fetcher: site({ page: page('not-found'), number: UNKNOWN }), solveCaptcha: async () => '7191' });
    await expect(unknown.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    const blocked = new SunspeedyTracker({ fetcher: vi.fn<typeof fetch>(async () => new Response('Forbidden', { status: 403 })), solveCaptcha: async () => '7191' });
    await expect(blocked.fetch(SAMPLE)).rejects.toMatchObject({ kind: 'challenge' });
    const moved = new SunspeedyTracker({ fetcher: vi.fn<typeof fetch>(async () => new Response('', { status: 302, headers: { Location: '/' } })), solveCaptcha: async () => '7191' });
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
