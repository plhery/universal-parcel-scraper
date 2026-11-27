import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer, STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { parseFreightways } from '../nz-couriers/freightways.js';
import { statusMap as nzCouriersMap } from '../nz-couriers/status.js';
import { POST_HASTE_API } from '../post-haste/adapter.js';
import { adapter, PASS_THE_PARCEL_API, PassTheParcelTracker } from './adapter.js';
import { PASS_THE_PARCEL, parsePassTheParcel, passTheParcelQuery } from './parser.js';
import { statusMap } from './status.js';

// The public codes the fixtures were read for, and a code the site's barcode check calls invalid.
const DELIVERED = '1RBB-1LBZ-I5E1-6LMG';
const DELAYED = '1RBB-18BZ-B1H1-6J58';
const UNKNOWN = '1RBB0000ZZZZ0000';

type Row = Record<string, unknown>;
type Item = Row & { trackingEvents: Row[] };
type Reply = Row & { consignmentItems: Item[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply, scans: Row[]) => void) => {
  const reply = fixture(name);
  change(reply, reply.consignmentItems[0]!.trackingEvents);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const empty = () => new Response(null, { status: 204 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const VALIDATION = { errors: { query: ['The field query must be a string or array type with a minimum length of \'6\'.'] },
  type: 'https://httpstatuses.com/400', title: 'REQUEST_VALIDATION_ERROR', status: 400 };

describe('Pass the Parcel HTTP adapter', () => {
  it('asks the Freightways lookup under Post Haste’s name once, with the code without its dashes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PassTheParcelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(DELIVERED.toLowerCase(), { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(PASS_THE_PARCEL_API).toBe(POST_HASTE_API);
    expect(String(url)).toBe(`${PASS_THE_PARCEL_API}?query=1RBB1LBZI5E16LMG`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pass-the-parcel', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the whole trip, across both networks, without the signatory, the links, the postcode or the courier', () => {
    const result = parsePassTheParcel(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-10-16T02:49:36.493Z', delivered_at: '2026-10-16T02:49:36.493Z',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-10-16T02:49:36.493Z', 'D', 'Delivered', 'delivered', 'Seatoun, Wellington City'],
      ['2026-10-16T00:21:30.956Z', 'ONBD', 'Out for Delivery', 'out_for_delivery', null],
      ['2026-10-14T22:27:26Z', 'P', 'Picked Up', 'accepted', 'Springfield, Rotorua District'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Signer|example\.invalid|SIGV|6022|3015|ROTORUA|WLG|31496|12-901|NZCouriers|PostHaste/);
  });

  it('names no delivery carrier, whichever network made the newest scan', () => {
    // Post Haste delivered the parcel New Zealand Couriers picked up; the default would name Post Haste.
    expect(parseFreightways({ ...PASS_THE_PARCEL, namesDeliveryCarrier: undefined }, fixture('delivered'), DELIVERED))
      .toMatchObject({ delivery_carrier: 'post-haste' });
    expect(parsePassTheParcel(fixture('delivered'), DELIVERED)).not.toHaveProperty('delivery_carrier');
    const handedOn = changed('delivered', (_body, scans) => { scans.forEach((scan) => { scan.carrierName = 'NZCouriers'; }); });
    expect(parseFreightways({ ...PASS_THE_PARCEL, namesDeliveryCarrier: undefined }, handedOn, DELIVERED))
      .toMatchObject({ delivery_carrier: 'nz-couriers' });
    expect(parsePassTheParcel(handedOn, DELIVERED)).not.toHaveProperty('delivery_carrier');
  });

  it('reads a transit delay notice as in transit by its wording, and drops the delivery photo', () => {
    const result = parsePassTheParcel(fixture('delayed'), DELAYED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2025-07-02T00:40:39.097Z' });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.stage_source ?? null])).toEqual([
      ['D', 'delivered', 'carrier_map'], ['ONBD', 'out_for_delivery', 'carrier_map'],
      ['STAT/DELAY', 'in_transit', 'wording:language'], ['P', 'accepted', 'carrier_map'],
    ]);
    expect(result.events![2]).toMatchObject({ time: '2025-07-01T03:34:05.295Z', description: 'Potential Transit Delay', location: 'Ngauranga, Wellington City' });
    expect(JSON.stringify(result)).not.toMatch(/Signer|example\.invalid|Photo/);
    // While the parcel is still on its way, the delay notice is its newest stage.
    const delayed = parsePassTheParcel(changed('delayed', (body, scans) => { body.consignmentItems[0]!.trackingEvents = scans.slice(0, 2); }), DELAYED);
    expect(delayed).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Potential Transit Delay' });
    expect(delayed).not.toHaveProperty('delivered_at');
  });

  it('counts a consignment only when it names the whole code asked', () => {
    expect(parsePassTheParcel(changed('delivered', (body) => { body.shortConsignmentId = '1rbb1lbzi5e16lmg'; }), DELIVERED).events).toHaveLength(3);
    for (const shortId of ['1RBB1LBZI5E16LMH', '1RBB1LBZI5E16LM', 'ZZZ 1RBB1LBZI5E16LMG', '1RBB-1LBZ-I5E1-6LMG']) {
      expect(() => parsePassTheParcel(changed('delivered', (body) => { body.shortConsignmentId = shortId; }), DELIVERED), shortId)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', provider: 'Pass the Parcel', message: 'Pass the Parcel answered for another consignment' }));
    }
  });

  it('reads a consignment without scans as no history, and rejects a changed reply', () => {
    expect(() => parsePassTheParcel(changed('delivered', (body) => { body.consignmentItems = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', provider: 'Pass the Parcel' }));
    for (const change of [
      (body: Reply) => { delete body.shortConsignmentId; },
      (body: Reply) => { body.consignmentItems = 'parcels' as never; },
      (_body: Reply, scans: Row[]) => { scans[1]!.createdOn = '2026-10-16T13:21:30'; },
      (_body: Reply, scans: Row[]) => { scans[0]!.location = 'Springfield'; },
      (_body: Reply, scans: Row[]) => { delete scans[2]!.eventType; },
    ]) {
      expect(() => parsePassTheParcel(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema', provider: 'Pass the Parcel' }));
    }
  });

  it('keeps an unknown code, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(empty())).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found', provider: 'Pass the Parcel' });
    await expect(lookup({ message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://posthaste.co.nz/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(VALIDATION, { status: 400 })).rejects.toMatchObject({ kind: 'invalid_input', message: 'Pass the Parcel refused the number' });
    await expect(lookup('<html><title>Bad Request</title></html>', { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge', message: 'Pass the Parcel answered with a browser check' });
    await expect(lookup('<html><title>Pass the Parcel</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    // A reply for another code is not a missing parcel.
    await expect(lookup(fixture('delivered'))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('declares no recognition', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('rejects anything but a Parcel Tracking Code, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // Post Haste's own numbers, which the same lookup holds: a ticket, a charge label, an SSCC and a customer
    // printed label's consignment number. Then a code one character short or long, one with a leading zero,
    // one with punctuation and an overlong input.
    for (const number of ['ZZZZ 01234566', '01234567', '00000000000000000000', 'ZZZ123456', '1RBB1LBZI5E16LM', '1RBB1LBZI5E16LMGZ',
      '0RBB1LBZI5E16LMG', '1RBB_1LBZ_I5E1_6LMG', `1RBB${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input', provider: 'Pass the Parcel' });
      await expect(new PassTheParcelTracker({ fetcher }).fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(() => parsePassTheParcel(fixture('delivered'), number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(passTheParcelQuery(' 1rbb 1lbz i5e1 6lmg ')).toEqual({ kind: 'label', number: '1RBB1LBZI5E16LMG', query: '1RBB1LBZI5E16LMG' });
  });

  it('gives its one read the whole budget and ends a hanging read inside it', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a code filed under Pass the Parcel to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pass-the-parcel' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pass-the-parcel', source: 'pass-the-parcel', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(PASS_THE_PARCEL_API))).toBe(true);
  });
});

describe('Pass the Parcel status vocabulary', () => {
  it('uses New Zealand Couriers’ map of the group’s scan types', () => {
    expect(statusMap).toBe(nzCouriersMap);
    expect(STATUS_MAPS['pass-the-parcel']).toBe(nzCouriersMap);
    expect(statusMapAnswer({ carrier: 'pass-the-parcel', providerCode: 'P', description: 'Picked Up' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'pass-the-parcel', providerCode: 'D', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
