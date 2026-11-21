import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTrackingsGe, TRACK_URL } from './parser.js';
import { statusMap } from './status.js';

const NUMBER = '901209910387000';
const OTHER = '904417730582261';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const found = fixture('ozon-canceled');
const missing = fixture('not-found');
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as
  { entries: { code?: string; wording: string; stage: string }[] };

/** The sample's reply with other records and page rows. */
function reply(records: { code: string; date: string; number?: string }[], rows: [string, string][]): string {
  const payload = JSON.parse(found) as Record<string, unknown> & { data: Record<string, unknown>[] };
  const template = payload.data[0]!;
  payload.data = records.map(({ code, date, number = NUMBER }) => ({
    ...template, status_code: code, status_date: date, cust_track_num_01: number, gcb_track_num: number,
  }));
  payload.tracking_tree = rows.map(([day, wording]) => `<li class="list-group-item p-1"><div>`
    + `<span class="badge bg-dark text-white ml-1"> ${day} </span><span class="mr-1"><span>&nbsp;${wording}</span></span></div></li>`).join('\n');
  return JSON.stringify(payload);
}

const page = '<html><head><meta name="csrf-token" content="Synthetic0Form0Token0Value0Of0Forty0Chars"></head></html>';
const environment = (fetcher: typeof fetch) => ({ fetcher, userAgent: 'Test Agent', trawl: null, browserExecutablePath: null,
  recorder: NOOP_RECORDER, env: {} });
/** The tracker page, with the session cookie it sets. */
function opened(): Response {
  const response = new Response(page, { headers: { 'Set-Cookie': 'trackingsge_session=synthetic; Path=/; HttpOnly' } });
  Object.defineProperty(response, 'url', { value: TRACK_URL });
  return response;
}
const lookup = (answer: Response) => adapter(environment(vi.fn<typeof fetch>()
  .mockResolvedValueOnce(opened()).mockResolvedValueOnce(answer))).track({ number: NUMBER }, { budgetMs: 5000 });

describe('Trackings.GE guest tracking', () => {
  it('reads the row the page shows with the clock and code of the record it renders', () => {
    const result = parseTrackingsGe(found, NUMBER);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', last_update: null,
      last_update_local: '2025-11-28T10:30:02',
      last_status_text: 'We are sorry, but it seems that sending of this parcel was canceled',
    });
    // The record of code 901 has no row on the page, and no wording to show.
    expect(result.events).toEqual([{
      local_time: '2025-11-28T10:30:02', provider_code: '666', description: 'Order canceled', stage: 'exception', stage_source: 'carrier_map',
    }]);
  });

  it('reads the tracker\'s own not-found answer, and only that, as not found', () => {
    expect(() => parseTrackingsGe(missing, OTHER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTrackingsGe('{"err_msg":"error"}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const body of ['', '{', '[]', '{}', '<html><body>Server Error</body></html>']) {
      expect(() => parseTrackingsGe(body, NUMBER), body).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTrackingsGe('<html><title>Just a moment...</title></html>', NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('requires every record to name the number asked', () => {
    expect(() => parseTrackingsGe(found, OTHER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = reply([{ code: '666', date: '2025-11-28 10:30:02' }, { code: '901', date: '2026-02-25 13:38:16', number: OTHER }],
      [['2025-11-28', 'Order canceled']]);
    expect(() => parseTrackingsGe(mixed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    // The posting number the merchant gives the order names it too.
    expect(parseTrackingsGe(found, '59197141-0022-1'.replace(/-/g, '')).events).toHaveLength(1);
  });

  it('does not read the layout of orders booked on Trackings.GE itself, or a reply without records', () => {
    expect(() => parseTrackingsGe(JSON.stringify({ err_msg: 'track_found', source: 'trackings.ge', html: '<li>Delivered</li>' }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTrackingsGe(JSON.stringify({ ...JSON.parse(found), data: [] }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTrackingsGe(reply([{ code: '901', date: '2026-02-25 13:38:16' }], []), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('dates rows by their records only where the pairing is certain, newest first', () => {
    // Oldest first on the page, as its dates show: each day's records pair with its rows in order.
    const result = parseTrackingsGe(reply([
      { code: '100', date: '2025-11-20 09:00:00' }, { code: '200', date: '2025-11-21 08:00:00' },
      { code: '300', date: '2025-11-21 17:00:00' }, { code: '901', date: '2025-11-22 12:00:00' },
      { code: '400', date: '2025-11-23 10:00:00' }, { code: '666', date: '2025-11-23 11:00:00' },
    ], [['2025-11-20', 'Received'], ['2025-11-21', 'In transit'], ['2025-11-21', 'Out for delivery'], ['2025-11-23', 'Order canceled']]), NUMBER);
    expect(result.events?.map((event) => [event.local_time, event.provider_code, event.description])).toEqual([
      // Two records of the day and one row: the row keeps its date.
      ['2025-11-23', undefined, 'Order canceled'],
      ['2025-11-21T17:00:00', '300', 'Out for delivery'],
      ['2025-11-21T08:00:00', '200', 'In transit'],
      ['2025-11-20T09:00:00', '100', 'Received'],
    ]);
    expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery' });

    // Rows of a single day, whose order the page's dates cannot tell, keep the date and their order.
    const day = parseTrackingsGe(reply([{ code: '100', date: '2025-11-20 09:00:00' }, { code: '200', date: '2025-11-20 18:00:00' }],
      [['2025-11-20', 'Received'], ['2025-11-20', 'In transit']]), NUMBER);
    expect(day.events?.map((event) => [event.local_time, event.provider_code, event.description])).toEqual([
      ['2025-11-20', undefined, 'In transit'], ['2025-11-20', undefined, 'Received'],
    ]);
  });

  it('keeps a date it cannot read as text', () => {
    const result = parseTrackingsGe(reply([{ code: '666', date: '2025-11-28 10:30:02' }], [['28.11.2025', 'Order canceled']]), NUMBER);
    expect(result.events?.[0]).toEqual(expect.objectContaining({ provider_time_text: '28.11.2025', description: 'Order canceled' }));
    expect(result.events?.[0]).not.toHaveProperty('local_time');
  });

  it('opens a session on the tracker and posts the number with its form token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(opened())
      .mockResolvedValueOnce(new Response(found, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }));
    await expect(adapter(environment(fetcher)).track({ number: ` ${NUMBER} ` }, { budgetMs: 5000 }))
      .resolves.toMatchObject({ current_stage: 'exception' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [lookupUrl, lookupInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([pageUrl, lookupUrl].map(String)).toEqual([TRACK_URL, TRACK_URL]);
    expect(pageInit).toMatchObject({ signal: expect.any(AbortSignal), redirect: 'manual' });
    expect(lookupInit).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), redirect: 'manual' });
    const headers = new Headers(lookupInit.headers);
    expect(headers.get('User-Agent')).toBe('Test Agent');
    expect(headers.get('X-CSRF-TOKEN')).toBe('Synthetic0Form0Token0Value0Of0Forty0Chars');
    expect(headers.get('Cookie')).toBe('trackingsge_session=synthetic');
    expect(String(lookupInit.body)).toBe(`track_num=${NUMBER}`);
  });

  it('does not read a refusal, a missing page or an expired form as a missing parcel', async () => {
    await expect(lookup(new Response('Not Found', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(new Response('{"message":"Too Many Attempts."}', { status: 429, headers: { 'Retry-After': '30' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup(new Response('<title>Page Expired</title>', { status: 419 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html>oops</html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(new Response(''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(new Response(missing))).rejects.toMatchObject({ kind: 'not_found' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html><title>Just a moment...</title></html>'));
    await expect(adapter(environment(blocked)).track({ number: NUMBER }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'challenge' });
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it('refuses input that is not one tracking code before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(adapter(environment(fetcher)).track({ number: 'ab/12' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers the wordings its statuses.json records', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMap.stage(code ?? null, normalizeStatusWording(wording)), wording).toBe(stage);
    }
  });
});
