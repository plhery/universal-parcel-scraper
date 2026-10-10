import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HermesGermanyTracker, parseHermesGermanyResponse } from './adapter.js';
import { sameInstantIdentityPolicy } from '../../app.js';
import { STATUSES } from './status.js';

const NUMBER = 'H1234567890123456789';

const fixture = (name: string): Array<Record<string, unknown>> => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
) as Array<Record<string, unknown>>;
const delivered = () => fixture('delivered-neighbour');
const outForDelivery = () => fixture('out-for-delivery');
const atShop = (code: string): Array<Record<string, unknown>> => [{
  barcode: NUMBER,
  address: { addressType: 'PARCELSHOP', lastName: 'Example Kiosk', street: 'Beispielweg 1', zipCode: '10115', city: 'Beispielstadt', parcelShopId: '1' },
  parcelProgress: [
    { parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
    { parcelStatus: code, timestamp: '2026-09-03T09:00:00Z', historyText: 'Synthetic wording' },
  ],
}];
const capabilities = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

afterEach(() => vi.restoreAllMocks());

describe('Hermes Germany', () => {
  it('orders and deduplicates real milestones, keeping display text but dropping address PII', () => {
    const result = parseHermesGermanyResponse(delivered(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'registered']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE STREET');
    expect(JSON.stringify(result)).not.toContain('PRIVATE RECIPIENT');
    expect(result.events?.[0]?.description).toContain('Nachbarn');
    expect(result.last_update).toBe('2026-09-03T09:00:00.000Z');
  });

  it('covers every capability declared in carrier.json', () => {
    expect(capabilities).toEqual(['history', 'eta', 'sender_name', 'delivered_at', 'pickup_point', 'provider_code']);
    const result = parseHermesGermanyResponse(delivered(), NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
    expect(result.sender_name).toBe('Example Webshop GmbH');
    expect(result.delivered_at).toBe('2026-09-03T09:00:00.000Z');
    const active = parseHermesGermanyResponse(outForDelivery(), NUMBER);
    expect(active).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-09-03' });
    expect(parseHermesGermanyResponse(atShop('PARCELSHOP_READY_FOR_COLLECTION'), NUMBER).pickup_point).toBeTruthy();
  });

  it('ignores the pre-announcement preference booking', () => {
    const result = parseHermesGermanyResponse(outForDelivery(), NUMBER);
    expect(result.events?.map((event) => event.provider_code))
      .toEqual(['DELIVERY_TOUR_STARTED', 'HANDED_OVER', 'ANNOUNCED']);
  });

  it.each([
    ['ATG_OUT_OF_WAREHOUSE', 'registered'],
    ['RETURN_TO_SENDER', 'returned'],
    ['RETURN_DELIVERED_TO_SENDER', 'returned'],
    ['RETOURE_DELIVERED', 'returned'],
    ['DELIVERY_FAILED', 'failed_attempt'],
    ['READY_FOR_PICKUP', 'ready_for_pickup'],
  ])('does not confuse %s with delivery', (code, stage) => {
    expect(STATUSES[code]?.stage).toBe(stage);
    const payload = [{ barcode: NUMBER, parcelProgress: [{ parcelStatus: code, timestamp: '2026-09-03T09:00:00Z' }] }];
    expect(parseHermesGermanyResponse(payload, NUMBER).current_stage).toBe(stage);
  });

  it('rejects missing, ambiguous, mismatched and malformed histories', () => {
    expect(() => parseHermesGermanyResponse({}, NUMBER)).toThrow('invalid tracking response');
    expect(() => parseHermesGermanyResponse([], NUMBER)).toThrow('could not locate');
    expect(() => parseHermesGermanyResponse(delivered(), 'H9999999999999999999')).toThrow('different');
    expect(() => parseHermesGermanyResponse([...delivered(), ...delivered()], NUMBER)).toThrow('ambiguous');
    for (const parcelProgress of [[], [null], [{ parcelStatus: 'ANNOUNCED', timestamp: 'nonsense' }]]) {
      expect(() => parseHermesGermanyResponse([{ barcode: NUMBER, parcelProgress }], NUMBER)).toThrow();
    }
    expect(parseHermesGermanyResponse([{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'FUTURE_STATUS', timestamp: '2026-09-03T09:00:00Z' },
    ] }], NUMBER)).toMatchObject({ status: 'unknown' });
  });

  it('exposes sender and keeps unknown latest as unknown, not an error', () => {
    const result = parseHermesGermanyResponse(delivered(), NUMBER);
    expect(result).toMatchObject({ sender_name: 'Example Webshop GmbH', delivered_at: '2026-09-03T09:00:00.000Z' });
    const unknown = parseHermesGermanyResponse([{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'FUTURE_STATUS', timestamp: '2026-09-03T09:00:00Z' },
    ] }], NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown' });
  });

  it('only requests the public history and never the address endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(delivered())));
    await expect(new HermesGermanyTracker().fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`https://api.my-deliveries.de/tnt/v2/shipments/search/${NUMBER}`,
      expect.objectContaining({ cache: 'no-store', redirect: 'error', headers: expect.objectContaining({ 'X-Language': 'de' }) }));
  });

  it('reads a delivery at the address as a delivery', () => {
    const payload = delivered();
    payload[0]!.parcelProgress = (payload[0]!.parcelProgress as Array<Record<string, unknown>>).map((entry) => entry.parcelStatus === 'DELIVERED_NEIGHBOUR'
      ? { ...entry, parcelStatus: 'DELIVERED_INHOUSE', historyText: 'Die Sendung wurde an der Empfangsadresse zugestellt.' } : entry);
    payload[0]!.parcelAttributes = { ...(payload[0]!.parcelAttributes as object), delivered: false };
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', provider_code: 'DELIVERED_INHOUSE' });
  });

  it('does not give an unknown historical update the delivered shipment stage', () => {
    const payload = delivered();
    (payload[0]!.parcelProgress as unknown[]).push({ parcelStatus: 'FUTURE_STATUS', timestamp: '2026-09-02T09:00:00Z' });
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.events?.find((event) => event.provider_code === 'FUTURE_STATUS')).not.toHaveProperty('stage');
  });

  it.each([
    ['PARCELSHOP_READY_FOR_COLLECTION', 'ready_for_pickup', 'out_for_delivery'],
    ['PARCELSHOP_COLLECTED_BY_CUSTOMER', 'delivered', 'delivered'],
    ['INTERNATIONAL_DELIVERED', 'delivered', 'delivered'],
    ['DELIVERY_FAILED_ADDRESS_PROBLEM', 'failed_attempt', 'exception'],
  ])('reads %s as %s', (code, stage, status) => {
    const payload = [{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
      { parcelStatus: code, timestamp: '2026-09-03T09:00:00Z', historyText: 'Synthetic wording' },
    ] }];
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result).toMatchObject({ status, current_stage: stage });
    expect(result.events?.[0]).toMatchObject({ stage, provider_code: code });
  });

  it('drops a booked ParcelShop like a booked safe place', () => {
    const payload = [{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
      { parcelStatus: 'EDL_BOOKED_PARCELSHOP', timestamp: '2026-09-03T09:00:00Z', historyText: 'Für die Sendung wurde ein WunschPaketShop gebucht.' },
    ] }];
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result.events?.map((event) => event.provider_code)).toEqual(['SORTED']);
    expect(result.current_stage).toBe('in_transit');
  });

  it('names the ParcelShop that holds the parcel or handed it over, and no other address', () => {
    expect(parseHermesGermanyResponse(atShop('PARCELSHOP_READY_FOR_COLLECTION'), NUMBER).pickup_point)
      .toBe('Example Kiosk\nBeispielweg 1\n10115 Beispielstadt');
    expect(parseHermesGermanyResponse(atShop('PARCELSHOP_COLLECTED_BY_CUSTOMER'), NUMBER))
      .toMatchObject({ current_stage: 'delivered', pickup_point: 'Example Kiosk\nBeispielweg 1\n10115 Beispielstadt' });
    // A booked shop the parcel never reached, and addresses that are not a shop.
    expect(parseHermesGermanyResponse(atShop('DELIVERED_NEIGHBOUR'), NUMBER).pickup_point).toBeUndefined();
    expect(parseHermesGermanyResponse(atShop('SORTED'), NUMBER).pickup_point).toBeUndefined();
    for (const addressType of ['HOMEDELIVERY', 'NEIGHBOUR', 'DROPOFF']) {
      const payload = atShop('PARCELSHOP_READY_FOR_COLLECTION');
      payload[0]!.address = { ...(payload[0]!.address as object), addressType };
      const result = parseHermesGermanyResponse(payload, NUMBER);
      expect(result.pickup_point).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('Beispielweg');
    }
  });

  it('keeps a stored Hermes scan by its instant and status code when its stage changes', () => {
    expect(sameInstantIdentityPolicy('hermes-de')).toEqual({
      sourceCarrierId: 'hermes-de', storedSources: ['hermes-de'], requireProviderCode: true,
    });
  });

  it.each([403, 404, 429, 503])('classifies HTTP %i without hiding outages', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
    await expect(new HermesGermanyTracker().fetch(NUMBER)).rejects.toMatchObject({
      status, name: status === 404 ? 'HermesGermanyTrackingError' : 'UpstreamHttpError',
    });
  });

  it('answers a number Hermes does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HermesGermanyTracker({ fetcher }).fetch('1234')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER }).recognize!('1234'))
      .resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
