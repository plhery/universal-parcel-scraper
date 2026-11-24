import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, COMMERCIVE_API, commerciveLookupUrl } from './adapter.js';
import { normalizeCommerciveNumber, parseCommercive } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The example number the tracker offers, and invented ones derived from it.
const NUMBER = 'CMV20126303007059175636', INVALID = 'CMV20126303007059175637', UNKNOWN = 'CMV99999999999999999999';

type Scan = Record<string, unknown>;
type Answer = Record<string, unknown> & { events: Scan[] };
type Reply = { carrier: string; results: Answer[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The example's reply with its fields and its scans changed. */
const edit = (change: Record<string, unknown> = {}, scans?: (events: Scan[]) => Scan[]): Reply => {
  const reply = fixture('delivered'), answer = reply.results[0]!;
  return { ...reply, results: [{ ...answer, ...change, events: scans ? scans(answer.events) : answer.events }] };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Commercive Parcel numbers', () => {
  it('takes CMV and its digits, in capitals', () => {
    expect(normalizeCommerciveNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['', 'CMV123', '20126303007059175636', 'CMX20126303007059175636', `CMV${'1'.repeat(40)}`]) {
      expect(() => normalizeCommerciveNumber(other), other).toThrow('Enter the CMV tracking number');
    }
  });

  it('suggests Commercive Parcel for CMV and twenty digits whose last is their Luhn check', () => {
    expect(detectCarrierMatch('cmv 2012 6303 0070 5917 5636')).toMatchObject({ carrier: 'commercive-parcel', confidence: 'high', candidates: ['commercive-parcel'] });
    for (const other of [INVALID, 'CMV2012630300705917563', 'CMV201263030070591756360', 'CMW20126303007059175636', 'CM20126303007059175636']) {
      expect(detectCarrierMatch(other)?.carrier, other).not.toBe('commercive-parcel');
    }
  });
});

describe('Commercive Parcel tracking adapter', () => {
  it('asks the tracking API as the tracking page does, in capitals', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: NUMBER.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${COMMERCIVE_API}?numbers=${NUMBER}`);
    expect(commerciveLookupUrl(NUMBER)).toBe(`https://commerciveparcel.com/api/track?numbers=${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'commercive-parcel', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s answers for an unknown and a wrong number', async () => {
    const answer = (name: string, number: string) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(name))))
      .track({ number }).catch((error: unknown) => error);
    expect(await answer('not-found', UNKNOWN)).toMatchObject({ kind: 'not_found' });
    expect(await answer('invalid', INVALID)).toMatchObject({ kind: 'invalid_input' });
  });

  it('keeps refusals, challenges, error pages and redirects apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: UNKNOWN }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({ error: 'Too many requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Vercel Security Checkpoint</title>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({ error: 'Forbidden' }, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>Not Found</h1>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 308, headers: { Location: 'https://www.commerciveparcel.com/api/track' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Commercive Parcel replies', () => {
  it('reads the example: its scans as instants, the line and where it went', () => {
    const result = parseCommercive(fixture('delivered'), NUMBER);
    const events = result.events ?? [];
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'delivered',
      last_status_text: 'Delivered', last_update: '2026-11-08T01:24:57Z', delivered_at: '2026-11-08T01:24:57Z',
      expected_delivery: null, service_name: 'Parcel Priority', destination_country: 'US',
    });
    expect(result.summary_only).toBeUndefined();
    expect(result.unread_estimates).toBeUndefined();
    expect(events).toHaveLength(19);
    expect(events[0]).toEqual({ time: '2026-11-08T01:24:57Z', description: 'Delivered', location: 'Cheektowaga, US',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(events.at(-1)).toEqual({ time: '2026-10-30T12:04:29Z', description: 'Order information received',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(events.every((event, index) => index === 0 || event.time! <= events[index - 1]!.time!)).toBe(true);
    // The recipient's address and the delivery photos stay behind.
    expect(JSON.stringify(result)).not.toMatch(/recipient|photo|proof|NY"/i);
  });

  it('takes the stage from the newest scan when the code is unknown, and leaves its estimate unread', () => {
    const open = edit({ status: 'pending_review', statusLabel: 'Pending review', deliveredAt: null, estimatedDelivery: '2026-11-10T00:00:00.000Z' },
      (scans) => scans.slice(1));
    const result = parseCommercive(open, NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      provider_code: 'pending_review', unread_estimates: ['results.estimatedDelivery'] });
    expect(result.delivered_at).toBeUndefined();
    expect(result.last_status_text).toBe(result.events![0]!.description);
  });

  it('reads a parcel without scans as a summary', () => {
    const result = parseCommercive(edit({ status: 'in_transit', statusLabel: 'In transit', deliveredAt: null }, () => []), NUMBER);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      provider_code: 'in_transit', last_status_text: 'In transit', last_update: null, expected_delivery: null,
      service_name: 'Parcel Priority', destination_country: 'US', summary_only: true, events: [] });
  });

  it('refuses another parcel’s reply', () => {
    expect(() => parseCommercive(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const scan = (change: Scan) => (scans: Scan[]) => [{ ...scans[0], ...change }, ...scans.slice(1)];
    const both = fixture('delivered');
    for (const reply of [null, {}, { results: {} }, { ...both, results: [...both.results, ...both.results] },
      edit({ found: 'yes' }), edit({ found: false, reason: 'blocked' }), { ...both, results: [{ ...both.results[0]!, events: {} }] },
      edit({}, scan({ time: '2026-11-08 01:24:57' })), edit({}, scan({ time: '2026-02-30T01:24:57.000Z' })),
      edit({}, scan({ description: null })), edit({}, scan({ location: 7 })), edit({}, (scans) => [...scans, 'scan' as unknown as Scan]),
      edit({ status: 'Delivered' }), edit({ status: null, statusLabel: null }, () => []),
      edit({}, (scans) => Array.from({ length: 301 }, () => scans[0]!))]) {
      expect(() => parseCommercive(reply, NUMBER), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Commercive Parcel statuses', () => {
  it('maps each code and wording the tracker gives', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && typeof entry.code === 'string' ? entry.code : null;
      const wording = 'wording' in entry && typeof entry.wording === 'string' ? entry.wording : '';
      expect(statusMap.stage(code, wording), code ?? wording).toBe(entry.stage);
      // A code the page colours but no scan has shown stands for its own wording.
      expect(statusMapAnswer({ carrier: 'commercive-parcel', providerCode: code, description: wording || code! })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('in_transit', 'Out for delivery')).toBe('out_for_delivery');
    expect(statusMap.stage('xyz', 'anything')).toBeUndefined();
  });
});
