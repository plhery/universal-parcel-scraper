import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, BpostTracker } from './adapter.js';
import { normalizeBpostNumber, parseBpost } from './parser.js';
import { classifyBpostStatus } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '000000000000000000000001';
const OTHER = '000000000000000000000002';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const payload = () => structuredClone(fixture);
const POINT = 'Example Post Point\nExample Street 1\n1000 Example Town';

describe('bpost direct history', () => {
  it('reads the identity-bound timeline and preserves clocks without inventing offsets', () => {
    const result = normalizeCarrierResult(parseBpost(payload(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-01-04T12:00:00', weight_kg: 0.32, dimensions_text: '26.1 × 7.5 × 38.4 cm', expected_delivery: null,
      delivered_at: '2026-01-04T12:00:00+01:00', destination_country: 'BE', pickup_point: POINT });
    expect(result).not.toHaveProperty('international_tracking_number');
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'out_for_delivery', 'in_transit', 'registered']);
    expect(result.events?.every((event) => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|recipient|receiver|sender|actualDeliveryTime|activeStep/);
    const declared = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    const waiting = payload(); waiting.items[0].events.shift();
    const evidence: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.[0]?.location),
      weight: typeof result.weight_kg === 'number', dimensions: Boolean(result.dimensions_text), delivered_at: Boolean(result.delivered_at),
      pickup_point: Boolean(parseBpost(waiting, NUMBER).pickup_point) };
    for (const capability of declared.capabilities) expect(evidence[capability], capability).toBe(true);
  });

  it('requires both parcel and search identity and rejects ambiguous results', () => {
    const wrong = payload(); wrong.items[0].itemCode = OTHER;
    const alias = payload(); alias.items[0].searchCode = OTHER;
    const duplicate = payload(); duplicate.items.push(duplicate.items[0]);
    for (const value of [null, {}, { items: [] }, { items: [null] }, wrong, alias, duplicate]) {
      expect(() => parseBpost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const multiple = payload(); multiple.items.unshift({ ...payload().items[0], itemCode: OTHER, searchCode: OTHER, events: [] });
    expect(parseBpost(multiple, NUMBER).status).toBe('delivered');
  });

  it('accepts only the explicit batch negative and leaves other errors inconclusive', () => {
    expect(() => parseBpost({ error: 'NO_DATA_FOUND' }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const value of [{ error: 'NO_DATA_FOUND', items: [] }, { error: 'INVALID_POSTAL_CODE' }, { error: 'MAINTENANCE' }]) {
      expect(() => parseBpost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const empty = payload(); empty.items[0].events = [];
    expect(() => parseBpost(empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each(['2026-02-30', '2026-13-01', '', '01/04/2026'])('rejects invalid date %s without promoting earlier progress', (date) => {
    const value = payload(); value.items[0].events[0].date = date;
    expect(() => parseBpost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['25:00', '12:60', '', '12:00Z'])('rejects invalid clock %s', (time) => {
    const value = payload(); value.items[0].events[0].time = time;
    expect(() => parseBpost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects malformed or excessive scans and keeps provider order across countries', () => {
    for (const scan of [null, {}, { ...payload().items[0].events[0], key: { EN: { description: '' } } }]) {
      const value = payload(); value.items[0].events[0] = scan;
      expect(() => parseBpost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const excessive = payload(); excessive.items[0].events = Array(501).fill(excessive.items[0].events[0]);
    expect(() => parseBpost(excessive, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const order = payload(); order.items[0].events[1].date = '2026-01-05';
    expect(parseBpost(order, NUMBER).last_update_local).toBe('2026-01-04T12:00:00');
    order.items[0].events.push(order.items[0].events[0]);
    expect(parseBpost(order, NUMBER).events).toHaveLength(5);
  });

  it('keeps pickup availability, unrecognized scans and return delivery distinct', () => {
    const pickup = payload(); pickup.items[0].events.shift();
    expect(parseBpost(pickup, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup', pickup_point: POINT });
    // The point's code and the receiver's fields are never read.
    expect(JSON.stringify(parseBpost(pickup, NUMBER))).not.toMatch(/PRIVATE/);
    const unknown = payload(); unknown.items[0].events[0].key.EN.description = 'Delivery expected';
    expect(parseBpost(unknown, NUMBER).status).toBe('unknown');
    expect(parseBpost(unknown, NUMBER).events?.[0]).not.toHaveProperty('stage');
    const returned = payload(); returned.items[0].retourOrBackToSender = true;
    expect(() => parseBpost(returned, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    returned.items[0].activeStep.knownProcessStep = 'DELIVERED_TO_SENDER';
    expect(parseBpost(returned, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(parseBpost(returned, NUMBER)).not.toHaveProperty('pickup_point');
    expect(parseBpost(returned, NUMBER).events?.[0]).toMatchObject({ provider_leg: 'return', stage: 'returned' });
    expect(classifyBpostStatus('Item available at Pick-up point')?.stage).toBe('ready_for_pickup');
    for (const wording of ['__proto__', 'constructor', 'Delivery expected']) expect(classifyBpostStatus(wording)).toBeUndefined();
  });

  it('keeps the pickup point after collection there, never after a door delivery or in transit', () => {
    for (const step of ['PICKED_UP_IN_POST_POINT', 'PICKED_UP_IN_KARIBOO_POINT', 'PICKED_UP_IN_PARCEL_LOCKER',
      'PICKED_UP_IN_SHOP', 'PICKED_UP_IN_PICKUP_POINT_INTERNATIONAL']) {
      const value = payload(); value.items[0].activeStep.knownProcessStep = step;
      expect(parseBpost(value, NUMBER).pickup_point, step).toBe(POINT);
    }
    for (const activeStep of [{ name: 'delivered', knownProcessStep: 'DELIVERED_AT_HOME' },
      { name: 'delivered', knownProcessStep: 'DELIVERED_AT_NEIGHBOUR' }, { name: 'delivered' }, null]) {
      const value = payload(); value.items[0].activeStep = activeStep;
      expect(parseBpost(value, NUMBER)).toMatchObject({ current_stage: 'delivered' });
      expect(parseBpost(value, NUMBER)).not.toHaveProperty('pickup_point');
    }
    // bpost's step alone is no collection: the newest scan must be the delivery.
    const transit = payload(); transit.items[0].events.splice(0, 2);
    expect(parseBpost(transit, NUMBER)).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(parseBpost(transit, NUMBER)).not.toHaveProperty('pickup_point');
  });

  it('lays out the point as name, street and number, then postcode and town, in one language', () => {
    const point = () => { const value = payload(); return [value, value.items[0].deliveryPoint] as const; };
    let [value, deliveryPoint] = point();
    delete deliveryPoint.street.en;
    expect(parseBpost(value, NUMBER).pickup_point).toBe('Example Post Point\nRue Exemple 1\n1000 Ville Exemple');
    [value, deliveryPoint] = point();
    delete deliveryPoint.name.en; delete deliveryPoint.streetNumber.en; delete deliveryPoint.postcode.en;
    expect(parseBpost(value, NUMBER).pickup_point).toBe('Point Poste Exemple\nExample Street 1\n1000 Example Town');
    [value, deliveryPoint] = point();
    deliveryPoint.streetNumber = {}; deliveryPoint.postcode = null;
    expect(parseBpost(value, NUMBER).pickup_point).toBe('Example Post Point\nExample Street\nExample Town');
    for (const field of ['street', 'municipality']) {
      [value, deliveryPoint] = point(); deliveryPoint[field] = { en: ' ' };
      expect(parseBpost(value, NUMBER).pickup_point, field).toBe('Example Post Point');
    }
    // Street and town in no common language: the name alone.
    [value, deliveryPoint] = point(); deliveryPoint.street = { fr: 'Rue Exemple' }; deliveryPoint.municipality = { nl: 'Voorbeeldstad' };
    expect(parseBpost(value, NUMBER).pickup_point).toBe('Example Post Point');
    [value, deliveryPoint] = point(); deliveryPoint.name = 'Example Post Point';
    expect(parseBpost(value, NUMBER)).not.toHaveProperty('pickup_point');
    [value] = point(); value.items[0].deliveryPoint = 'Example Post Point';
    expect(parseBpost(value, NUMBER)).not.toHaveProperty('pickup_point');
  });

  it('reads the destination country code and another S10 number the sender printed', () => {
    for (const [countryCode, expected] of [['fr', 'FR'], ['Belgium', undefined], ['B', undefined], [56, undefined]] as const) {
      const value = payload(); value.items[0].receiver.countryCode = countryCode;
      expect(parseBpost(value, NUMBER).destination_country).toBe(expected);
    }
    const s10 = payload(); s10.items[0].senderBarcode = 'CB123456785FR';
    expect(parseBpost(s10, NUMBER).international_tracking_number).toBe('CB123456785FR');
    s10.items[0].senderBarcode = 'CB123456784FR';
    expect(parseBpost(s10, NUMBER)).not.toHaveProperty('international_tracking_number');
    const same = payload();
    Object.assign(same.items[0], { itemCode: 'CB123456785BE', searchCode: 'CB123456785BE', senderBarcode: 'CB123456785BE' });
    expect(parseBpost(same, 'CB123456785BE')).not.toHaveProperty('international_tracking_number');
  });

  it('reads the delivery time on Brussels time, only for a delivered receiver in Belgium', () => {
    const summer = payload(); summer.items[0].actualDeliveryTime = { day: '2026-07-01', time: '14:11:05' };
    expect(parseBpost(summer, NUMBER).delivered_at).toBe('2026-07-01T14:11:05+02:00');
    for (const actualDeliveryTime of [undefined, null, '2026-07-01 14:11', { day: '2026-02-30', time: '12:00' },
      { day: '2026-07-01', time: '25:00' }, { day: '01/07/2026', time: '12:00' }, { day: '2026-07-01' }]) {
      const value = payload(); value.items[0].actualDeliveryTime = actualDeliveryTime;
      expect(parseBpost(value, NUMBER)).not.toHaveProperty('delivered_at');
    }
    // Abroad, bpost's clock may belong to another zone or partner.
    for (const countryCode of ['FR', '', undefined]) {
      const value = payload(); value.items[0].receiver.countryCode = countryCode;
      expect(parseBpost(value, NUMBER)).not.toHaveProperty('delivered_at');
    }
    const waiting = payload(); waiting.items[0].events.shift();
    expect(parseBpost(waiting, NUMBER)).not.toHaveProperty('delivered_at');
    const returned = payload(); returned.items[0].retourOrBackToSender = true;
    returned.items[0].activeStep.knownProcessStep = 'DELIVERED_TO_SENDER';
    expect(parseBpost(returned, NUMBER)).not.toHaveProperty('delivered_at');
  });

  it('keeps only explicitly labelled positive measurements', () => {
    for (const weightInGrams of [0, -1, '320', null, Infinity]) {
      const value = payload(); value.items[0].weightInGrams = weightInGrams;
      expect(parseBpost(value, NUMBER)).not.toHaveProperty('weight_kg');
    }
    for (const dimensionsInCm of ['26 x 7 x 38', '0cm x 7cm x 38cm', '26in x 7in x 38in', '']) {
      const value = payload(); value.items[0].dimensionsInCm = dimensionsInCm;
      expect(parseBpost(value, NUMBER)).not.toHaveProperty('dimensions_text');
    }
  });
});

describe('bpost anonymous batch request', () => {
  it('recognizes matching history and explicit absence while preserving lookup failures', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(payload())));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'NO_DATA_FOUND' })));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'INVALID_POSTAL_CODE' })));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...payload(), items: [] })));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('sends one bounded request without postcode, session or authentication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.track({ number: '000000 000000 000000 000001' })).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://track.bpost.cloud/track/items');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ barcodes: [NUMBER] }), cache: 'no-store', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.has('Cookie')).toBe(false);
    expect(headers.has('Authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(normalizeBpostNumber('rr 000000005 be')).toBe('RR000000005BE');
  });

  it('takes bpost\'s JJBE licence plate and no other licence plate', () => {
    expect(normalizeBpostNumber('jjbe a99 0000000000000001')).toBe('JJBEA990000000000000001');
    for (const other of ['JJBEA99000000000000001', 'JJBEAB90000000000000001', 'JJFI61234500000000001', 'JJD0000000000000000000']) {
      expect(() => normalizeBpostNumber(other)).toThrow('bpost requires');
    }
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s distinct from a parcel negative', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status: Number(status) }));
    await expect(new BpostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects unsupported inputs before I/O, propagates cancellation and bounds response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const invalid of ['123', 'RR000000006BE', `${NUMBER}&postalCode=1234`]) {
      await expect(new BpostTracker({ fetcher: unused }).fetch(invalid)).rejects.toThrow(InvalidInputError);
    }
    await expect(new BpostTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new BpostTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const invalidJson = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Unavailable</html>'));
    await expect(new BpostTracker({ fetcher: invalidJson }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
});
