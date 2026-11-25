import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { adapter, ASL_API, aslLookupUrl } from './adapter.js';
import { normalizeAslNumber, parseAsl } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The example number ASL Track's documentation gives, and invented ones: the example with a wrong
// check digit, and another whose check digit holds.
const NUMBER = 'ASL42613845454', WRONG = 'ASL42613845455', UNKNOWN = 'ASL12345678903';

type Scan = Record<string, unknown>;
type Reply = Record<string, unknown> & { events: Scan[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The example's reply with its fields and its scans changed. */
const edit = (change: Record<string, unknown> = {}, scans?: (events: Scan[]) => Scan[]): Reply => {
  const reply = fixture('delivered');
  return { ...reply, ...change, events: scans ? scans(reply.events) : reply.events };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ASL Track numbers', () => {
  it('takes ASL and eleven digits whose last is their Luhn check, in capitals', () => {
    expect(normalizeAslNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['', 'ASL4261384545', 'ASL426138454540', 'ASX42613845454', '42613845454']) {
      expect(() => normalizeAslNumber(other), other).toThrow('Enter the ASL tracking number');
    }
    expect(() => normalizeAslNumber(WRONG)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('suggests ASL Track for its numbers alone and reads them out of its tracking links', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'asl-track', confidence: 'high', candidates: ['asl-track'] });
    for (const other of [WRONG, 'ASL4261384545', 'ASL426138454540']) {
      expect(detectCarrierMatch(other)?.carrier, other).not.toBe('asl-track');
    }
    expect(parseTrackingInput(`https://asltrack.com/track/${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'asl-track' });
  });
});

describe('ASL Track tracking adapter', () => {
  it('asks the documented API, in capitals', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: NUMBER.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ASL_API}${NUMBER}`);
    expect(aslLookupUrl(NUMBER)).toBe(`https://asltrack.com/api/v1/track/${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'asl-track', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the API’s 404 answer as not found, and refuses a wrong check digit without asking', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const unasked = vi.fn<typeof fetch>();
    await expect(carrier(unasked).track({ number: WRONG })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(unasked).not.toHaveBeenCalled();
  });

  it('keeps refusals, challenges, error pages and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: UNKNOWN }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({ error: 'Too many requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Vercel Security Checkpoint</title>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({ error: 'Forbidden' }, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>404: NOT_FOUND</h1>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json({ error: 'Not found' }, { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 308, headers: { Location: 'https://www.asltrack.com/api/v1/track/x' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('ASL Track replies', () => {
  it('reads the example: the carrier’s wall clocks, ASL Track’s own stamp as an instant, and where it went', () => {
    const result = parseAsl(fixture('delivered'), NUMBER);
    const events = result.events ?? [];
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'delivered',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-09-23T15:22:00', expected_delivery: null,
      destination_country: 'US',
    });
    expect(result.delivered_at).toBeUndefined();
    expect(result.summary_only).toBeUndefined();
    expect(result.unread_estimates).toBeUndefined();
    expect(events).toHaveLength(14);
    expect(events[0]).toEqual({ local_time: '2026-09-23T15:22:00', description: 'Delivered', location: 'Alvin, US',
      provider_code: 'delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events.find(({ description }) => description === 'In transit')).toEqual({ time: '2026-09-22T11:02:48.625Z',
      description: 'In transit', provider_code: 'in_transit', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events.at(-1)).toEqual({ local_time: '2026-09-20T23:59:00', description: 'Shipping label created', location: 'Auburn, WA',
      provider_code: 'info_received', stage: 'registered', stage_source: 'carrier_map' });
    expect(events.filter((event) => event.time)).toHaveLength(1);
    // The origin and destination towns stay behind.
    expect(JSON.stringify(result)).not.toMatch(/Alvin, TX|origin/);
  });

  it('dates the wall clocks by their places, the label in Washington on Pacific time', () => {
    const dated = dateLocalClocks('asl-track', parseAsl(fixture('delivered'), NUMBER));
    expect(dated.events!.at(-1)).toMatchObject({ local_time: '2026-09-20T23:59:00', time: '2026-09-20T23:59:00-07:00' });
    expect(dated.events!.find(({ location }) => location === 'Lakeland, FL')).toMatchObject({ time: '2026-09-21T12:55:00-04:00' });
  });

  it('takes the stage from the newest scan when the code is unknown, and leaves the estimate unread', () => {
    const open = edit({ status: 'pending_review', estimated_delivery: '2026-09-24', delivered_at: null }, (scans) => scans.slice(1));
    const result = parseAsl(open, NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      provider_code: 'pending_review', unread_estimates: ['estimated_delivery'], last_status_text: 'Out for delivery' });
  });

  it('reads a shipment without scans as a summary', () => {
    expect(parseAsl(edit({ status: 'info_received' }, () => []), NUMBER)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', provider_code: 'info_received', last_status_text: null, last_update: null, expected_delivery: null,
      destination_country: 'US', summary_only: true, events: [] });
  });

  it('refuses another shipment’s reply', () => {
    expect(() => parseAsl(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const scan = (change: Scan) => (scans: Scan[]) => [{ ...scans[0], ...change }, ...scans.slice(1)];
    for (const reply of [null, [], {}, edit({ found: 'yes' }), { ...fixture('delivered'), events: {} },
      edit({}, scan({ occurred_at: '2026-09-23 15:22:00' })), edit({}, scan({ occurred_at: '2026-02-30T15:22:00+00:00' })),
      edit({}, scan({ description: null })), edit({}, scan({ location: 7 })), edit({}, scan({ status: 'Delivered' })),
      edit({}, (scans) => [...scans, 'scan' as unknown as Scan]), edit({ status: 'Delivered' }), edit({ status: null }, () => []),
      edit({}, (scans) => Array.from({ length: 201 }, () => scans[0]!))]) {
      expect(() => parseAsl(reply, NUMBER), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('ASL Track statuses', () => {
  it('maps each code and wording the API gives', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && typeof entry.code === 'string' ? entry.code : null;
      const wording = 'wording' in entry && typeof entry.wording === 'string' ? entry.wording : '';
      expect(statusMap.stage(code, wording), code ?? wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'asl-track', providerCode: code, description: wording || code! })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('in_transit', 'Out for delivery')).toBe('out_for_delivery');
    expect(statusMap.stage('xyz', 'anything')).toBeUndefined();
  });
});
