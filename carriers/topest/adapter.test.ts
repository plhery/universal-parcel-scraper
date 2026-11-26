import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TOPEST_TRACKER } from './adapter.js';
import { normalizeTopestNumber, parseTopest } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, the delivering post's number its reply gives, and the invented number fixtures/not-found.json answers.
const SAMPLE = 'SZTB622432824YQ';
const ONWARD = 'LX005979451NL';
const UNKNOWN = 'SZTB999999999YQ';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (name: string) => JSON.parse(fixture(name)) as Record<string, unknown>;
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The public sample's reply with only these rows. */
const withRows = (...rows: unknown[]) => ({ ...reply('delivered'), data: rows });

describe('TOPEST numbers', () => {
  it('takes letters and digits with a digit', () => {
    expect(normalizeTopestNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeTopestNumber(ONWARD)).toBe(ONWARD);
    for (const other of ['', 'SZTB', 'ABCDEFGHIJ', '1234567', `${'A'.repeat(29)}12`, 'X'.repeat(70)]) {
      expect(() => normalizeTopestNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('TOPEST tracking adapter', () => {
  it('posts the number as the site’s tracking page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TOPEST_TRACKER);
    expect(init).toMatchObject({ method: 'POST', body: `TrackingNo=${SAMPLE}`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'topest', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number the tracker does not take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'SZTB' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads code 1 without rows as not found', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing number', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json('<title>Runtime Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html><body>Service Unavailable</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 301, headers: { Location: 'https://www.topestexpress.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"code":"2","msg":"error","data":[]}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('TOPEST replies', () => {
  it('reads the public sample: wall clocks newest first, the day alone at midnight, and PostNL’s parcel number', () => {
    const result = parseTopest(reply('delivered'), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The item has been delivered successfully', last_update: null, last_update_local: '2026-04-11T10:08:00',
      expected_delivery: null, delivery_carrier: 'spring-gds', delivery_tracking_number: ONWARD,
    });
    expect(result.events).toHaveLength(25);
    expect(result.events![0]).toEqual({ local_time: '2026-04-11T10:08:00', description: 'The item has been delivered successfully', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events![1]).toMatchObject({ description: 'The item is available at the pickuppoint', stage: 'ready_for_pickup' });
    expect(result.events!.find((event) => event.description === 'Parcel is leaving Airport, Parcel Leaving Port')).toMatchObject({ local_time: '2026-03-22' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-03-14T09:49:19', description: 'Parcel Data Received', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.location)).toBe(true);
  });

  it('answers the delivering post’s number too, and keeps an unknown wording for the shared rules', () => {
    expect(parseTopest(reply('delivered'), ONWARD)).toMatchObject({ current_stage: 'delivered', delivery_tracking_number: ONWARD });
    const result = parseTopest(withRows({ OccurTime: '2026-04-12 09:00:00', DetailDesc: 'Returned to sender', Location: 'Utrecht' },
      { OccurTime: '2026-03-14 09:49:19', DetailDesc: 'Parcel Data Received', Location: '' }), SAMPLE);
    expect(result.events![0]).toEqual({ local_time: '2026-04-12T09:00:00', description: 'Returned to sender', location: 'Utrecht', stage: 'returned', stage_source: expect.stringMatching(/^wording/) });
    // A reply without the post's number, or with one no rule claims, names no delivering carrier.
    for (const TrackingNo of ['', SAMPLE, 'ZZ12345678']) {
      expect(parseTopest({ ...reply('delivered'), TrackingNo }, SAMPLE)).not.toHaveProperty('delivery_carrier');
    }
  });

  it('refuses a reply for another number, and a changed reply', () => {
    expect(() => parseTopest(reply('delivered'), 'SZTB622432825YQ')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const body of [
      withRows({ OccurTime: '2026-13-14 09:49:19', DetailDesc: 'Parcel Data Received', Location: '' }),
      withRows({ OccurTime: '14/03/2026 09:49', DetailDesc: 'Parcel Data Received', Location: '' }),
      withRows({ OccurTime: '2026-03-14 09:49:19', DetailDesc: '', Location: '' }),
      withRows('row'),
      { ...reply('delivered'), data: null },
      { ...reply('delivered'), code: 0 },
      [], null, 'text',
    ]) expect(() => parseTopest(body, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTopest(withRows(), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
  });

  it('answers each wording statuses.json records by its stage', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'topest', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
  });
});
