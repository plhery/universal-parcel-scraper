import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AUSTWAY_TRACKER } from './adapter.js';
import { normalizeAustwayNumber, parseAustway } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, the waybill its page gives, and the invented number fixtures/not-found.html answers.
const SAMPLE = 'AXP0216971';
const WAYBILL = 'LP00805322393174';
const UNKNOWN = 'AXP9999999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, place: string, wording: string) =>
  `<tr><td style="text-align: center">1</td><td>${clock}</td><td>${place}</td><td>${wording}</td></tr>`;
/** The public sample's page with only these rows. */
const withRows = (...rows: string[]) => fixture('delivered').replace(/(<tbody>)[\s\S]*?(<\/tbody>)/, `$1${rows.join('')}$2`);

describe('Austway numbers', () => {
  it('takes letters and digits with a digit', () => {
    expect(normalizeAustwayNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeAustwayNumber(WAYBILL)).toBe(WAYBILL);
    for (const other of ['', 'AXP0216', 'ABCDEFGHIJ', `${'A'.repeat(29)}12`, 'X'.repeat(70)]) {
      expect(() => normalizeAustwayNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Austway tracking adapter', () => {
  it('posts the number as the tracking page’s form does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(AUSTWAY_TRACKER);
    expect(init).toMatchObject({ method: 'POST', body: `orderNos=${SAMPLE}`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'austway', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number the tracker does not take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'AXP' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the page’s "未查询到相关轨迹" as not found', async () => {
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

describe('Austway pages', () => {
  it('reads the public sample: wall clocks newest first, the day alone at midnight, the status before "--" as the code', () => {
    const result = parseAustway(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'Delivered',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-05-04T07:13:35', expected_delivery: null,
    });
    expect(result.events).toHaveLength(19);
    expect(result.events![0]).toEqual({ local_time: '2026-05-04T07:13:35', description: 'DELIVERED', location: 'ALBURY, NSW',
      provider_code: 'Delivered', original_description: 'Delivered--DELIVERED', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events![6]).toEqual({ local_time: '2026-04-29T17:02:00', description: 'IN TRANSIT TO AGENT ALBURY',
      location: 'BANKSTOWN AERODROME, NSW', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![9]).toMatchObject({ description: 'The importer\'s customs clearance has started successfully', location: 'SYD', stage: 'customs' });
    expect(result.events![16]).toEqual({ local_time: '2026-04-02', description: 'order checkout', location: '东莞仓', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-03-31T22:00:00', description: 'SHIPMENT CREATED', provider_code: 'InfoReceived',
      original_description: 'InfoReceived--SHIPMENT CREATED', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('answers the waybill too, and leaves an unknown wording to the shared rules', () => {
    expect(parseAustway(fixture('delivered'), WAYBILL)).toMatchObject({ current_stage: 'delivered' });
    const result = parseAustway(withRows(row('2026-05-05 09:00:00', 'ALBURY, NSW', 'Returned to sender'),
      row('2026-05-04 09:00:00', 'ALBURY, NSW', 'Exception--CARD LEFT')), SAMPLE);
    expect(result.events![0]).toEqual({ local_time: '2026-05-05T09:00:00', description: 'Returned to sender', location: 'ALBURY, NSW',
      stage: 'returned', stage_source: expect.stringMatching(/^wording/) });
    expect(result.events![1]).toMatchObject({ description: 'CARD LEFT', provider_code: 'Exception' });
    expect(parseAustway(withRows(row('2026-04-29 17:02:00', 'BANKSTOWN AERODROME, NSW', 'IN TRANSIT TO AGENT WAGGA WAGGA')), SAMPLE).events![0])
      .toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('refuses a page for another number, and a changed page', () => {
    expect(() => parseAustway(fixture('delivered'), 'AXP0216972')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const page of [
      withRows(row('2026-13-04 07:13:35', 'ALBURY, NSW', 'Delivered--DELIVERED')),
      withRows(row('04/05/2026 07:13', 'ALBURY, NSW', 'Delivered--DELIVERED')),
      withRows(row('2026-05-04 07:13:35', 'ALBURY, NSW', '')),
      withRows('<tr><td>1</td><td>2026-05-04 07:13:35</td><td>DELIVERED</td></tr>'),
      fixture('delivered').replace('name="orderNos"', 'name="numbers"'),
      fixture('delivered') + fixture('delivered').slice(fixture('delivered').indexOf('<div class="tracking-item">')),
      fixture('not-found').replace('未查询到相关轨迹', '系统繁忙'),
      '',
    ]) expect(() => parseAustway(page, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAustway(withRows(), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
  });

  it('answers each row statuses.json records by its stage', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'austway', providerCode: code, description: wording }), `${code} ${wording}`).toEqual({ kind: 'mapped', stage });
    }
    expect(statusMapAnswer({ carrier: 'austway', providerCode: 'OutForDelivery', description: 'WITH DRIVER' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'austway', providerCode: 'Exception', description: 'CARD LEFT' })).toEqual({ kind: 'unknown' });
  });
});
