import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, normalizeSkynetInNumber, parseSkynetIn, parseSkynetInReply, SKYNET_IN_API, SkynetInTracker, withoutPeople } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// Synthetic: no public air waybill of Skynet Express India is known.
const NUMBER = 'SKY000000001';
const UNKNOWN = 'TEST00000000';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
type Reply = ReturnType<typeof fixture>;
/** The synthetic reply with one change to its result. */
const changed = (edit: (result: Reply) => void): Reply => { const reply = fixture('synthetic-delivered'); edit(reply.results[0]); return reply; };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (reply: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => reply());
const outcome = (reply: () => Response, number = NUMBER) => carrier(replying(reply)).track({ number }).catch((error: unknown) => error);

describe('Skynet Express India tracking adapter', () => {
  it('posts the whole number as the page does, with the supplied transport and budget', async () => {
    const fetcher = replying(() => json(fixture('synthetic-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new SkynetInTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(9);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.skynetww.com/api/tracking');
    expect(SKYNET_IN_API).toBe(String(url));
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: JSON.stringify({ awbs: [NUMBER] }),
      headers: expect.objectContaining({ 'Content-Type': 'application/json', Origin: 'https://www.skynetww.com',
        Referer: 'https://www.skynetww.com/in-en/tracking', 'User-Agent': 'SyntheticHost/1' }) });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skynet-in', step: 'direct', outcome: 'ok' }));
    expect(carrier(fetcher)).toMatchObject({ id: 'skynet-in', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number the page cannot take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'ABC' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['', 'AB1', 'ABCDEFGHIJ', `${'1'.repeat(41)}`, 'X'.repeat(70), 'SKY00000000?1']) {
      expect(() => normalizeSkynetInNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(normalizeSkynetInNumber(' sky-000 000 001 ')).toBe(NUMBER);
    expect(normalizeSkynetInNumber('000000000000')).toBe('000000000000');
  });

  it('reads the service’s answer for a number it does not know as not found', async () => {
    expect(await outcome(() => json(fixture('not-found')), UNKNOWN)).toMatchObject({ kind: 'not_found' });
  });

  it.each([[404, 'transport'], [410, 'transport'], [302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'],
    [503, 'maintenance']] as const)('reads HTTP %i as %s, never as a missing parcel', async (status, kind) => {
    const failure = await outcome(() => new Response(status === 302 ? null : '<html></html>',
      { status, headers: status === 302 ? { Location: '/in-en' } : { 'Retry-After': '30' } }));
    expect(failure).toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 30_000 } : {}) });
  });

  it('reads a verification page as a challenge and another page as a changed service', async () => {
    const page = (body: string) => () => new Response(body, { headers: { 'Content-Type': 'text/html' } });
    expect(await outcome(page('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await outcome(page('<!DOCTYPE html><html><head><title>Track Your Shipment | Skynet</title></head><body></body></html>')))
      .toMatchObject({ kind: 'schema' });
  });

  it('sends the lookup once more when it fails to reach the service', async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('synthetic socket reset');
      return json(fixture('synthetic-delivered'));
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new SkynetInTracker({ fetcher, recorder }).fetch(NUMBER, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    await expect(new SkynetInTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new SkynetInTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection, while no rule offers the carrier a number', async () => {
    const answer = await createTracker({ fetcher: replying(() => json(fixture('synthetic-delivered'))), env: {}, providers: [] })
      .track({ carrier: 'skynet-in', number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'skynet-in', source: 'skynet-in' });
    expect(answer.result.events).toHaveLength(9);
    expect(numbers.records).toHaveLength(0);
    for (const number of [NUMBER, '123456789012', '12345678901']) expect(detectCarrierMatch(number).candidates).not.toContain('skynet-in');
  });
});

describe('Skynet Express India replies', () => {
  it('reads the scans newest first on their wall clocks, staged by their label keys', () => {
    const result = parseSkynetIn(fixture('synthetic-delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'delivered',
      last_status_text: 'Shipment delivered', last_update: null, last_update_local: '2026-03-09T14:05:00', expected_delivery: null,
      destination_country: 'GB' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.description, event.location])).toEqual([
      ['2026-03-09T14:05:00', 'delivered', 'delivered', 'Shipment delivered', 'EXAMPLETON'],
      ['2026-03-09T08:12:30', 'information', null, 'Recipient informed of delivery', 'EXAMPLETON'],
      ['2026-03-09T08:10:00', 'outForDelivery', 'out_for_delivery', 'Out for delivery', 'EXAMPLETON'],
      ['2026-03-06T17:45:00', 'customsCleared', 'in_transit', 'Customs cleared', 'EXAMPLE AIRPORT'],
      // Without the service's wording, the page's label stands.
      ['2026-03-05T06:20:00', 'flightArrival', 'in_transit', 'Flight arrival', 'EXAMPLE AIRPORT'],
      ['2026-03-04T02:30:00', 'flightDeparture', 'in_transit', 'Departed on flight', 'NEW DELHI'],
      ['2026-03-03T19:00:00', 'inscanned', 'in_transit', 'Shipment inscanned at hub', 'NEW DELHI'],
      // A scan without a time keeps its day.
      ['2026-03-03', 'collection', 'accepted', 'Shipment picked up', 'NEW DELHI'],
      ['2026-03-02T11:00:00', 'booked', 'registered', 'Shipment Created', 'NEW DELHI'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The receiver, references, remarks, service and proof of delivery stay out.
    const text = JSON.stringify(result);
    for (const kept of ['Alex', 'Example,', '07700', 'REF-0001', 'Synthetic remark', 'SYNTHETIC EXPRESS', 'example.com', 'EXAMPLE HUB']) {
      expect(text, kept).not.toContain(kept);
    }
  });

  it('names the forwarding carrier only through a catalog carrier’s link and a number of its shape', () => {
    expect(parseSkynetIn(fixture('synthetic-delivered'), NUMBER)).toMatchObject({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    const partner = (edit: (result: Reply) => void) => {
      const { delivery_carrier, delivery_tracking_number } = parseSkynetIn(changed(edit), NUMBER);
      return { delivery_carrier, delivery_tracking_number };
    };
    // The link's own number stands in for a missing forwarding number.
    expect(partner((result) => { delete result.forwarderNo; })).toEqual({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    const none = { delivery_carrier: undefined, delivery_tracking_number: undefined };
    expect(partner((result) => { delete result.carrierUrl; })).toEqual(none);
    expect(partner((result) => { result.carrierUrl = 'https://example.com/track?id=1Z999AA10123456784'; })).toEqual(none);
    expect(partner((result) => { result.carrierUrl = 'javascript:alert(1)'; })).toEqual(none);
    expect(partner((result) => { result.forwarderNo = 'AB12'; })).toEqual(none);
    expect(partner((result) => { result.carrierUrl = `https://www.skynetww.com/in-en/tracking?awb=${NUMBER}`; })).toEqual(none);
  });

  it('keeps the destination’s name when it names no country, and reads none without a route', () => {
    expect(parseSkynetIn(changed((result) => { result.route.to = 'EXAMPLE ISLES'; }), NUMBER)).toMatchObject({ destination_country_name: 'EXAMPLE ISLES' });
    const routeless = parseSkynetIn(changed((result) => { result.route = null; }), NUMBER);
    expect(routeless.destination_country).toBeUndefined();
    expect(routeless.destination_country_name).toBeUndefined();
  });

  it('takes the name of whoever took the parcel and phone numbers out of the wording', () => {
    expect(withoutPeople('Shipment delivered to Alex Example, phone 07700 900000', [])).toBe('Shipment delivered');
    expect(withoutPeople('Received by: A. EXAMPLE (SELF)', [])).toBe('Received');
    expect(withoutPeople('Call Alex Example on +91 98765 43210 before delivery', ['Alex Example'])).toBe('Call on before delivery');
    expect(withoutPeople('Shipment Created', ['Al'])).toBe('Shipment Created');
  });

  it('reads a key the map does not know by its wording, and a scan without a key by its status', () => {
    const result = parseSkynetIn(changed((result) => {
      result.events[0] = { ...result.events[0], labelKey: 'newKey', status: 'NEW', details: 'Shipment delivered' };
      result.events[1] = { ...result.events[1], labelKey: null, status: 'SYNTHETIC NOTE', details: '' };
    }), NUMBER);
    expect(result.events![0]).toMatchObject({ provider_code: 'newKey', description: 'Shipment delivered', stage: 'delivered' });
    expect(result.events![0]!.stage_source).not.toBe('carrier_map');
    expect(result.events![1]).toMatchObject({ provider_code: 'SYNTHETIC NOTE', description: 'SYNTHETIC NOTE' });
  });

  it('reads the cancelled test booking’s layout as an exception', () => {
    const result = parseSkynetIn(changed((result) => {
      Object.assign(result, { category: 'exception', status: 'CANCELED', statusLabelKey: 'cancelled', errorState: true, progressStep: 1 });
      result.events = [
        { status: 'CANCELED', labelKey: 'cancelled', icon: 'x', details: 'Shipment Canceled', location: 'NEW DELHI', dateLabel: 'March 2, 2026', time: '11:04:00', completed: false },
        { status: 'BOOKED', labelKey: 'booked', icon: 'file', details: 'Shipment Created', location: 'NEW DELHI', dateLabel: 'March 2, 2026', time: '11:00:00', completed: false },
      ];
    }), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', provider_code: 'cancelled', last_status_text: 'Shipment Canceled' });
  });

  it('keeps the shipment’s own stage when no scan has one, and turns an oldest-first history round', () => {
    const noted = parseSkynetIn(changed((result) => { result.events = [result.events[1]]; }), NUMBER);
    expect(noted).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    const reversed = parseSkynetIn(changed((result) => { result.events.reverse(); }), NUMBER);
    expect(reversed.events!.map((event) => event.provider_code)).toEqual(parseSkynetIn(fixture('synthetic-delivered'), NUMBER).events!.map((event) => event.provider_code));
  });

  it('reads a booking without a scan as listed, and partners that timed out as a failure', () => {
    expect(() => parseSkynetIn(changed((result) => { result.events = []; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const timedOut = { results: [{ ...fixture('not-found').results[0], awb: NUMBER, airwayBillNo: NUMBER, timedOut: true }] };
    expect(() => parseSkynetIn(timedOut, NUMBER)).toThrow(expect.objectContaining({ kind: 'transport' }));
  });

  it('never reads an answer for another number, or a changed one, as a missing parcel', () => {
    const kind = (payload: unknown, number = NUMBER) => { try { parseSkynetIn(payload, number); return 'ok'; } catch (error) { return (error as { kind: string }).kind; } };
    expect(kind(fixture('not-found'), NUMBER)).toBe('indeterminate');
    expect(kind(changed((result) => { result.awb = 'SKY000000002'; }))).toBe('indeterminate');
    expect(kind(changed((result) => { result.airwayBillNo = 'SKY000000002'; }))).toBe('indeterminate');
    const notFound = { ...fixture('not-found').results[0], awb: NUMBER, airwayBillNo: NUMBER };
    for (const payload of [
      null, [], {}, { results: [] }, { results: {} }, { results: [notFound, notFound] }, { results: ['x'] },
      { results: [{ ...notFound, found: 'false' }] },
      { results: [{ ...notFound, category: 'exception' }] },
      { results: [{ ...notFound, events: [{}] }] },
      changed((result) => { result.provider = 'othersource'; }),
      changed((result) => { result.provider = null; }),
      changed((result) => { result.category = 'not-found'; }),
      changed((result) => { result.events = {}; }),
      changed((result) => { result.events[0] = 'x'; }),
      changed((result) => { result.detailRows = 'x'; }),
      changed((result) => { result.route = 'INDIA'; }),
      changed((result) => { result.events[0].dateLabel = '09/03/2026'; }),
      changed((result) => { result.events[0].dateLabel = 'February 30, 2026'; }),
      changed((result) => { result.events[0].dateLabel = ''; }),
      changed((result) => { result.events[0].time = '25:00:00'; }),
      changed((result) => { result.events[0].time = '2:05 PM'; }),
      changed((result) => { Object.assign(result.events[0], { details: '', labelKey: null, status: '' }); }),
    ]) {
      expect(kind(payload), JSON.stringify(payload)?.slice(0, 120)).toBe('schema');
    }
    expect(() => parseSkynetInReply('{"results":', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('stages every recorded label by its key, as the status map answers', () => {
    for (const entry of statuses.entries) {
      const answer = statusMapAnswer({ carrier: 'skynet-in', providerCode: entry.code, description: entry.wording });
      expect(answer, `${entry.code} ${entry.wording}`).toEqual('stage' in entry ? { kind: 'mapped', stage: entry.stage } : expect.objectContaining({ kind: 'intentional_gap' }));
    }
  });
});
