import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CORETRAILS_API } from './adapter.js';
import { coretrailsPlace, normalizeCoretrailsNumber, parseCoretrails } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json; the tests derive invented shipments from its reply.
const SAMPLE = 'CRT330596304272';
const OTHER = 'CRT000000000001';

type Scan = { content: string; date: string; location: string };
type Reply = { est_delivery_date: string | null; latest_status: string | null; shipping_events: Scan[]; tracking_number: string };
const sample = () => JSON.parse(readFileSync(new URL(`./fixtures/delivered-${SAMPLE}.json`, import.meta.url), 'utf8')) as Reply;
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
/** The not-found fixture: the status line and headers the service answered, with its empty body. */
function notFound(): Response {
  const [status, ...headers] = readFileSync(new URL('./fixtures/not-found.http', import.meta.url), 'utf8').trim().split('\n');
  return new Response(null, { status: Number(status!.split(' ')[1]), headers: headers.map((line) => line.split(/:\s*/, 2) as [string, string]) });
}
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Coretrails numbers', () => {
  it('takes CRT and digits, in any case and spacing', () => {
    expect(normalizeCoretrailsNumber(` crt 330596304272 `)).toBe(SAMPLE);
    for (const other of ['', '330596304272', 'CRT12345', 'CRTA30596304272', '1Z999AA10123456784', `CRT${'1'.repeat(25)}`]) {
      expect(() => normalizeCoretrailsNumber(other), other).toThrow('start with CRT');
    }
  });
});

describe('Coretrails tracking adapter', () => {
  it('asks the service the tracking page asks, for the number in capitals', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(sample()));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CORETRAILS_API}?tracking_number=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'coretrails', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the service’s empty 404 as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => notFound());
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, checks, error pages and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><div class="cf-turnstile"></div>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>500 Internal Server Error</title>', 500))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<h1>Not Found</h1>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.coretrails.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Coretrails replies', () => {
  it('reads the public sample: its scans on their wall clock, newest first, with towns and facilities', () => {
    const result = parseCoretrails(sample(), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'DELIVERED',
      last_status_text: 'Delivered, Individual Picked Up at Postal Facility', last_update: null,
      last_update_local: '2026-10-19T11:28:00', expected_delivery: null,
    });
    expect(result.events).toHaveLength(27);
    expect(result.events!.slice(0, 4)).toEqual([
      { local_time: '2026-10-19T11:28:00', description: 'Delivered, Individual Picked Up at Postal Facility', location: 'seneca rocks, WV 26884',
        stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-10-16T10:34:00', description: 'Available for Pickup', location: 'SENECA ROCKS, WV 26884',
        stage: 'ready_for_pickup', stage_source: 'carrier_map' },
      { local_time: '2026-10-16T10:02:00', description: 'Arrived at Post Office', location: 'SENECA ROCKS, WV 26884',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-10-15T10:32:00', description: 'Arrived at carrier Facility', location: 'DULLES VA DISTRIBUTION CENTER',
        stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result.events![4]).toEqual({ local_time: '2026-10-15T10:06:00', description: 'In Transit to Next Facility', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-10-05T14:17:00', description: 'Picked Up By Shipping Partner, carrier Awaiting Item',
      location: 'Casper WY 82601', stage: 'accepted', stage_source: 'carrier_map' });
    // Every scan has a stage, and no time carries the server's GMT label as an instant.
    expect(result.events!.every((event) => event.stage && !event.time)).toBe(true);
    // The recipient's post office box and the office's street address and hours stay behind.
    expect(JSON.stringify(result)).not.toMatch(/po box|ALLEGHENY|26884-|Mon-Fri|AM-/i);
  });

  it('keeps a town, a state and a ZIP code, or a facility’s name, and leaves out other places', () => {
    expect(coretrailsPlace('SWEDESBORO, NJ 08085')).toBe('SWEDESBORO, NJ 08085');
    expect(coretrailsPlace('  MERRIFIELD VA   DISTRIBUTION CENTER ')).toBe('MERRIFIELD VA DISTRIBUTION CENTER');
    expect(coretrailsPlace('12 main st, springfield, il, 62701, US')).toBe('springfield, IL 62701');
    expect(coretrailsPlace('')).toBeUndefined();
    // A street address that is not a post office named after its town, or another shape with digits, is dropped.
    for (const place of ['JANE DOE 12 MAIN ST SPRINGFIELD IL 62701', '12 main st', 'Unit 4, 12 main st, US']) {
      expect(coretrailsPlace(place), place).toBeUndefined();
    }
  });

  it('reads a reply without a mapped status by its newest scan, and an estimate by its day', () => {
    const reply = { ...sample(), latest_status: 'IN_TRANSIT', est_delivery_date: 'Tue, 20 Oct 2026 00:00:00 GMT' };
    reply.shipping_events = reply.shipping_events.slice(4);
    expect(parseCoretrails(reply, SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      provider_code: 'IN_TRANSIT', last_status_text: 'In Transit to Next Facility', expected_delivery: '2026-10-20' });
    reply.shipping_events = [{ content: 'Out for Delivery', date: 'Tue, 20 Oct 2026 07:10:00 GMT', location: 'SENECA ROCKS, WV 26884' }];
    expect(parseCoretrails({ ...reply, est_delivery_date: '2026-10-20' }, SAMPLE)).toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: '2026-10-20',
      events: [{ description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: expect.stringMatching(/^wording:/) }] });
  });

  it('answers a shipment without scans by its status alone', () => {
    expect(parseCoretrails({ ...sample(), shipping_events: [] }, SAMPLE)).toMatchObject({ current_stage: 'delivered', last_status_text: 'DELIVERED', summary_only: true, events: [] });
    expect(parseCoretrails({ ...sample(), latest_status: 'PRE_TRANSIT', shipping_events: [] }, SAMPLE))
      .toMatchObject({ status: 'unknown', last_status_text: 'PRE TRANSIT', summary_only: true });
    expect(() => parseCoretrails({ ...sample(), latest_status: null, shipping_events: [] }, SAMPLE)).toThrow('without a status or scans');
  });

  it('refuses a reply for another number', () => {
    expect(() => parseCoretrails({ ...sample(), tracking_number: OTHER }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const scan = sample().shipping_events[0]!;
    for (const reply of [null, [], {}, { ...sample(), tracking_number: 7 }, { ...sample(), latest_status: 'delivered' },
      { ...sample(), shipping_events: {} }, { ...sample(), shipping_events: [{ ...scan, date: '2026-10-19 11:28' }] },
      { ...sample(), shipping_events: [{ ...scan, date: 'Mon, 31 Feb 2026 11:28:00 GMT' }] }, { ...sample(), shipping_events: [{ ...scan, content: 7 }] },
      { ...sample(), shipping_events: [{ ...scan, location: 7 }] }]) {
      expect(() => parseCoretrails(reply, SAMPLE), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Coretrails statuses', () => {
  it('maps each status and scan recorded', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code ?? null : null;
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'coretrails', providerCode: code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('XYZ', 'anything')).toBeUndefined();
  });
});
