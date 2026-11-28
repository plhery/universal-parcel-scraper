import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { AAE_PAGE, AAE_TRACK, adapter } from './adapter.js';
import { normalizeAaeNumber, parseAae, parseAaeToken } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const accepted = fixture('accepted.html');
const notFound = fixture('not-found.html');
const number = '107139325';
const token = 'CfDJ8Synthetic_Token-0123456789abcdefghij';
const cookie = '.AspNetCore.Antiforgery.n2Izh2674Vk=CfDJ8SyntheticCookie';
// Synthetic: the tracking page cut down to its form token.
const searchPage = `<html><body><form><input name="__RequestVerificationToken" type="hidden" value="${token}" /></form></body></html>`;
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const page = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const session = () => page(searchPage, 200, { 'Set-Cookie': `${cookie}; path=/; samesite=strict; httponly` });

describe('AAE waybill numbers', () => {
  it('takes nine or ten digits', () => {
    expect(normalizeAaeNumber(' 1071 3932 5 ')).toBe(number);
    expect(normalizeAaeNumber('8612345678')).toBe('8612345678');
    for (const raw of ['10713932', '10713932512', 'AB1071393', `${number}/x`]) {
      expect(() => normalizeAaeNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('AAE tracker', () => {
  it('opens a session on the tracking page, then posts the number to its handler with the token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(session()).mockResolvedValueOnce(page(accepted));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [pageUrl, pageInit] = fetcher.mock.calls[0]!;
    expect(String(pageUrl)).toBe(AAE_PAGE);
    expect(pageInit?.method).toBe('GET');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(`${AAE_TRACK}&trackingNumber=${number}`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('');
    expect(init?.headers).toMatchObject({ Cookie: cookie, 'XSRF-TOKEN': token });
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '[洛杉矶分拨中心] 货件到达洛杉矶分拨中心', last_update: null, last_update_local: '2016-07-06T08:33:00',
    });
  });

  it('reads the rows newest first on their wall clock, with the branch that wrote them', () => {
    const { events = [] } = parseAae(accepted, number);
    expect(events.map((event) => [event.local_time, event.location, event.stage])).toEqual([
      ['2016-07-06T08:33:00', '洛杉矶分拨中心', 'in_transit'],
      ['2016-07-05T17:31:00', '洛杉矶公司', 'accepted'],
      ['2016-07-03T21:12:00', '洛杉矶公司', 'accepted'],
    ]);
    expect(events.some((event) => event.time)).toBe(false);
  });

  it('stages every recorded wording by the map, for any branch', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.replaceAll('{station}', 'NYC').toLowerCase())).toBe(entry.stage);
    }
    // Synthetic: a later wording the map does not know falls to the shared rules.
    const signed = accepted.replace('<ul class="sc-list">', '<ul class="sc-list"><li class="scl-item"><p class="create-time fll">2016-07-12 10:00</p><p class="state-txt fll">[上海公司] 已签收</p></li>');
    expect(parseAae(signed, number)).toMatchObject({ status: 'delivered', last_update_local: '2016-07-12T10:00:00' });
  });

  it('reads the page\'s token in either attribute order', () => {
    expect(parseAaeToken(searchPage)).toBe(token);
    expect(parseAaeToken(`<input type="hidden" value="${token}" name="__RequestVerificationToken">`)).toBe(token);
    expect(() => parseAaeToken('<input name="__RequestVerificationToken" type="hidden">')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reports a number the tracker holds nothing for as not found, only when the block names that number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(session()).mockResolvedValueOnce(page(notFound));
    await expect(tracker(fetcher).track({ number: '000000000' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseAae(notFound, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take a failure, a changed reply or a verification page for a missing waybill', async () => {
    expect(() => parseAae('<div class="dcc-item"></div>', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAae(`${accepted}${accepted}`, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAae(accepted.replace('2016-07-06 08:33', '06/07/2016 08:33'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAae(notFound.replace('没有找到这个跟踪号的结果', ''), '000000000')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><head><title>Just a moment...</title></head></html>', 403));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(session()).mockResolvedValueOnce(page('<html><body>请输入验证码</body></html>'));
    await expect(tracker(blocked).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const refused = vi.fn<typeof fetch>().mockResolvedValueOnce(session()).mockResolvedValueOnce(page('', 400));
    await expect(tracker(refused).track({ number })).rejects.toMatchObject({ kind: 'indeterminate' });
    const sessionless = vi.fn<typeof fetch>().mockResolvedValueOnce(page(searchPage));
    await expect(tracker(sessionless).track({ number })).rejects.toMatchObject({ kind: 'indeterminate' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><body>Service Unavailable</body></html>', 503));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(session()).mockResolvedValueOnce(page('<html><head><title>Error</title></head><body></body></html>'));
    await expect(tracker(other).track({ number })).rejects.toMatchObject({ kind: 'schema' });
  });
});
