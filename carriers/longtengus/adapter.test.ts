import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LongtengTracker, longtengTrackingUrl } from './adapter.js';
import { normalizeLongtengNumber, parseLongteng } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The reply to the public sample, and to an invented waybill the tracker does not know.
const SAMPLE = 'S2025100990405';
const INVENTED = 'S2019000000017';
// The lookup the sample was read at.
const READ_AT = Date.parse('2026-11-27T20:52:44Z');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const parse = (page: string, number = SAMPLE) => parseLongteng(page, number, READ_AT);
const row = (clock: string, text: string) => `<tr>\n<td class="w-fix-left-label">${clock}</td>\n<td class="text-left">${text}</td>\n</tr>`;
const TABLE = /(<table class="table table-borderless h6 text-left">)([\s\S]*?)(<\/table>)/;
/** The public sample's page with rows put after its newest. */
const withNewer = (...rows: string[]) => fixture(SAMPLE).replace(TABLE, `$1$2${rows.join('')}$3`);
/** The public sample's page with only these rows. */
const withRows = (...rows: string[]) => fixture(SAMPLE).replace(TABLE, `$1${rows.join('')}$3`);

describe('Longteng numbers', () => {
  it('takes S and thirteen digits', () => {
    expect(normalizeLongtengNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'S202510099040', 'S20251009904051', 'T2025100990405', '2025100990405', 'SS2025100990405', 'X'.repeat(70)]) {
      expect(() => normalizeLongtengNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Longteng tracking adapter', () => {
  it('asks the tracker’s page for the waybill over HTTPS', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(SAMPLE)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.longtengus.com/TrackingInfo?TrackginNO=S2025100990405');
    expect(longtengTrackingUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'longtengus', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number Longteng does not issue without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'S123' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).recognize!('S123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the tracker’s one "暂无查询结果" row as not found, and recognizes a waybill with rows', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(unknown).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(unknown).recognize!(INVENTED)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(SAMPLE)));
    await expect(carrier(known).recognize!(SAMPLE)).resolves.toEqual({ known: true, lastActivityAt: '2025-10-22T00:40:00.000Z' });
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing waybill', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Runtime Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Service Unavailable</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/Error' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html(fixture('not-found')))).toMatchObject({ kind: 'indeterminate' });
  });

  it('retries only a request that fails to reach the tracker', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(html(fixture(SAMPLE)));
    await expect(new LongtengTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

describe('Longteng pages', () => {
  it('reads the public sample: every row on US Pacific time, the courier’s number alone naming no one', () => {
    const result = parse(fixture(SAMPLE));
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '清关完毕，正在派送，单号：77122221658027',
      last_update: '2025-10-21T17:40:00-07:00', last_update_local: '2025-10-21T17:40:00', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events).toHaveLength(11);
    expect(result.events!.at(-1)).toEqual({
      time: '2025-10-09T16:22:22-07:00', time_zone: 'America/Los_Angeles', time_zone_basis: 'carrier', local_time: '2025-10-09T16:22:22',
      description: '运单创建，等待处理', stage: 'registered', stage_source: 'carrier_map',
    });
    // The arrival in China is stamped on the same clock, before the clearance.
    const arrival = result.events!.find((event) => event.description === '到达口岸，等待清关')!;
    expect(arrival).toMatchObject({ time: '2025-10-21T14:12:09-07:00', stage: 'customs' });
    expect(result.events!.map((event) => event.time)).toEqual([...result.events!.map((event) => event.time)].sort().reverse());
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time_zone === 'America/Los_Angeles')).toBe(true);
  });

  it('dates a winter row on standard time, keeps one wall clock of a repeated row, and leaves a row after the lookup its wall clock', () => {
    const winter = parse(withNewer(row('2025/12/1 9:05:12', '快件已签收')));
    expect(winter).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language', last_update: '2025-12-01T09:05:12-08:00' });
    const repeated = parse(withNewer(row('2025/10/21 17:40:00', '清关完毕，正在派送，单号：77122221658027')));
    expect(repeated.events).toHaveLength(11);
    const ahead = parseLongteng(fixture(SAMPLE), SAMPLE, Date.parse('2025-10-21T23:00:00Z'));
    expect(ahead).toMatchObject({ last_update: null, last_update_local: '2025-10-21T17:40:00' });
    expect(ahead.events![0]).toEqual({ local_time: '2025-10-21T17:40:00', description: '清关完毕，正在派送，单号：77122221658027', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(ahead.events![1]).toMatchObject({ time: '2025-10-21T15:36:00-07:00' });
  });

  it('names the courier in China only when the row names one and its rules offer the number', () => {
    const handoff = (text: string) => parse(withNewer(row('2025/10/22 9:00:00', text)));
    expect(handoff('清关完毕，顺丰速运派送，单号：100000000017')).toMatchObject({ delivery_carrier: 'sf-express', delivery_tracking_number: '100000000017', current_stage: 'in_transit' });
    for (const text of ['清关完毕，顺丰速运派送，单号：AB1000000000', '清关完毕，顺丰或中通派送，单号：100000000017', '清关完毕，正在派送，单号：100000000017']) {
      const result = handoff(text);
      expect(result, text).not.toHaveProperty('delivery_carrier');
      expect(result, text).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('refuses a page for another waybill, and a changed page', () => {
    expect(() => parse(fixture(SAMPLE), INVENTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const page of [
      withRows(row('2025/13/21 14:12:09', '到达口岸，等待清关')),
      withRows(row('2025/10/21 24:12:09', '到达口岸，等待清关')),
      withRows(row('21/10/2025 14:12', '到达口岸，等待清关')),
      withRows(row('2025/10/21 14:12:09', '')),
      withRows(row('2025/10/21 14:12:09', '暂无查询结果'), row('2025/10/21 14:12:09', '到达口岸，等待清关')),
      withRows('<tr><td>2025/10/21 14:12:09</td><td>到达口岸，等待清关</td></tr>'),
      withRows(),
      fixture(SAMPLE).replace('运单号：<span', '单号：<span'),
    ]) expect(() => parse(page)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('answers each wording statuses.json records by its stage', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'longtengus', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    // The hand-off row ends with another number each time.
    expect(statusMapAnswer({ carrier: 'longtengus', providerCode: null, description: normalizeStatusWording('清关完毕，正在派送，单号：100000000017') }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    // A delivery is left to the shared rules.
    expect(statusMapAnswer({ carrier: 'longtengus', providerCode: null, description: '快件已签收' })).toEqual({ kind: 'unknown' });
  });
});
