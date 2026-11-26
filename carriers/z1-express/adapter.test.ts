import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, z1TrackerUrl } from './adapter.js';
import { normalizeZ1Number, parseZ1 } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and the invented number fixtures/not-found.html answers.
const SAMPLE = 'ZY2600505069205538';
const UNKNOWN = 'ZY9999999999999999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The public sample's page with only these rows. */
const withLines = (...lines: string[]) => fixture('delivered')
  .replace(/(<td class="search_track_th2">)[\s\S]*?(<\/td>)/, `$1${lines.map((line) => `${line}<br>`).join('')}$2`);

describe('Z1 Express numbers', () => {
  it('takes ZY and sixteen digits', () => {
    expect(normalizeZ1Number(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'ZY260050506920553', 'ZY26005050692055380', 'ZX2600505069205538', '2600505069205538', 'X'.repeat(70)]) {
      expect(() => normalizeZ1Number(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Z1 Express tracking adapter', () => {
  it('asks the site’s tracking page for the number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://www.z1express.com/index.php?m=home&c=Search&a=track&trackNumber=ZY2600505069205538');
    expect(z1TrackerUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'z1-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number Z1 does not issue without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'ZY123' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the tracker’s "暂无数据" row as not found', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing number', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Runtime Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Service Unavailable</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Z1 Express pages', () => {
  it('reads the public sample: wall clocks in the tracker’s order, newest first, each step’s name as its code', () => {
    const result = parseZ1(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: '妥投',
      last_status_text: 'delivered', last_update: null, last_update_local: '2026-07-27T10:52:57', expected_delivery: null,
    });
    expect(result.events).toHaveLength(22);
    expect(result.events![0]).toEqual({ local_time: '2026-07-27T10:52:57', description: 'delivered', provider_code: '妥投', location: 'US',
      original_description: 'delivered-妥投-US', stage: 'delivered', stage_source: 'carrier_map' });
    // GOFO's rows, copied with their town and state, which join the place.
    expect(result.events![1]).toEqual({ local_time: '2026-07-27T06:34:44', description: 'Out for Delivery', provider_code: '转运中(尾程单号轨迹内容)',
      location: 'Salt Lake City, UT, US', original_description: 'Salt Lake City,UT, Out for Delivery,null-转运中(尾程单号轨迹内容)-US',
      stage: 'out_for_delivery', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-07-13T11:03:33', description: 'Parcel Data Received', provider_code: '包裹预报',
      location: 'Shenzhen', original_description: 'Parcel Data Received-包裹预报-Shenzhen', stage: 'registered', stage_source: 'carrier_map' });
    // The flight's departure stays before the clearance the tracker wrote after it with an earlier clock.
    expect(result.events!.map((event) => event.location).slice(-8, -5)).toEqual(['JFK', 'US', 'HKG']);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps a row of another shape whole, and leaves an unknown wording to the shared rules', () => {
    const result = parseZ1(withLines('2026-07-13 11:03:33.0 Parcel Data Received-包裹预报-Shenzhen',
      '2026-07-28 09:00:00.0 Returned to sender', '2026-07-29 09:00:00.0 Delivery attempted, nobody at home-转运中(尾程单号轨迹内容)-US'), SAMPLE);
    expect(result.events![1]).toEqual({ local_time: '2026-07-28T09:00:00', description: 'Returned to sender', stage: 'returned', stage_source: expect.stringMatching(/^wording/) });
    expect(result.events![0]).toMatchObject({ description: 'Delivery attempted, nobody at home', provider_code: '转运中(尾程单号轨迹内容)', location: 'US', stage: 'failed_attempt' });
  });

  it('refuses a page for another number, and a changed page', () => {
    expect(() => parseZ1(fixture('delivered'), 'ZY2600505069205539')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseZ1(fixture('not-found'), 'ZY2600505069205539')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const page of [
      withLines('2026-13-13 11:03:33.0 Parcel Data Received-包裹预报-Shenzhen'),
      withLines('2026-07-13 24:03:33.0 Parcel Data Received-包裹预报-Shenzhen'),
      withLines('13/07/2026 11:03:33 Parcel Data Received-包裹预报-Shenzhen'),
      withLines('2026-07-13 11:03:33.0'),
      fixture('delivered').replace('name="trackNumber"', 'name="number"'),
      fixture('delivered').replace(/class="search_track"/g, 'class="track"'),
      fixture('delivered').replace(/<td class="search_track_th2">/, '<td>'),
      '',
    ]) expect(() => parseZ1(page, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZ1(withLines(), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
  });

  it('answers each row statuses.json records by its stage', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'z1-express', providerCode: code, description: wording }), `${code} ${wording}`).toEqual({ kind: 'mapped', stage });
    }
    // A step that means one stage does whatever its wording; GOFO's step and the clearance step need theirs.
    expect(statusMapAnswer({ carrier: 'z1-express', providerCode: '揽件', description: 'Parcel received at Guangzhou Sorting Centre' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'z1-express', providerCode: '转运中(尾程单号轨迹内容)', description: 'Unread wording' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'z1-express', providerCode: '包裹清关', description: 'Customs inspection' })).toEqual({ kind: 'unknown' });
  });
});
