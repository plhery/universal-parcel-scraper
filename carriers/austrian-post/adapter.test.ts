import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AustrianPostTracker, normalizeAustrianPostNumber, parseAustrianPostResponse } from './adapter.js';
import { austrianPostEventStatus, austrianPostSummaryStatus } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '1000000000000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));

describe('Austrian Post public tracking', () => {
  it('binds history to the item and classifies scans independently of the summary', () => {
    const result = parseAustrianPostResponse(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', weight_kg: 0.45, last_update: '2026-03-29T13:00:00.747Z' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'failed_attempt', 'out_for_delivery', 'in_transit', 'registered']);
    expect(result.events?.[0]).toMatchObject({ location: 'Synthetic destination' });
  });

  it('reads the measured size, the delivery time and scan codes, and never a shipper', () => {
    const payload = fixture();
    payload.data.einzelsendung.dimensions = { length: 35, width: 31, height: 7 };
    payload.data.einzelsendung.shipper = { name: 'PRIVATE NAME', street: 'PRIVATE STREET', postalCode: 'PRIVATE CODE', city: 'PRIVATE CITY' };
    const result = parseAustrianPostResponse(payload, NUMBER);
    expect(result).toMatchObject({ dimensions_text: '35 × 31 × 7 cm', delivered_at: '2026-03-29T13:00:00.747Z' });
    expect(result.sender_name).toBeUndefined();
    expect(result.events?.map((event) => event.provider_code)).toEqual(['IZ', 'RU', 'AZT', 'BEI', 'AV']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    payload.data.einzelsendung.dimensions = { length: 35, width: 0, height: 7 };
    const unmeasured = parseAustrianPostResponse(payload, NUMBER);
    expect(unmeasured.dimensions_text).toBeUndefined();
  });

  it('never keeps a postcode as a scan place', () => {
    const payload = fixture();
    const scans: Array<{ status: string; eventPlaceName: string }> = payload.data.einzelsendung.sendungsEvents;
    scans.find((scan) => scan.status === 'IZ')!.eventPlaceName = 'PLZ 9873';
    scans.find((scan) => scan.status === 'AZT')!.eventPlaceName = 'Zustellbasis Beispielort, PLZ 8762';
    const result = parseAustrianPostResponse(payload, NUMBER);
    expect(result.events?.[0]).not.toHaveProperty('location');
    expect(result.events?.map((event) => event.location)).toContain('Zustellbasis Beispielort');
    expect(JSON.stringify(result)).not.toMatch(/PLZ|9873|8762/);
  });

  it('rejects a different returned item', () => {
    const payload = fixture();
    payload.data.einzelsendung.sendungsnummer = '1000000000000000000002';
    expect(() => parseAustrianPostResponse(payload, NUMBER)).toThrow('different shipment');
  });

  it('separates positive not-found from missing data, query errors and empty history', () => {
    expect(() => parseAustrianPostResponse({ data: { einzelsendung: null } }, NUMBER)).toThrow('could not locate');
    expect(() => parseAustrianPostResponse({ data: {} }, NUMBER)).toThrow('invalid tracking response');
    expect(() => parseAustrianPostResponse({ data: { einzelsendung: null }, errors: [{ message: 'Unavailable' }] }, NUMBER)).toThrow('could not complete');
    const payload = fixture();
    payload.data.einzelsendung.sendungsEvents = [];
    expect(() => parseAustrianPostResponse(payload, NUMBER)).toThrow('without tracking history');
  });

  it('requires scan wording and explicit timestamp offsets', () => {
    const payload = fixture();
    payload.data.einzelsendung.sendungsEvents[0].timestamp = '2026-03-28T12:00:00';
    expect(() => parseAustrianPostResponse(payload, NUMBER)).toThrow('incomplete scan');
    payload.data.einzelsendung.sendungsEvents[0].timestamp = '2026-03-28T12:00:00+02:00';
    payload.data.einzelsendung.sendungsEvents[0].trackingDesc = '';
    expect(() => parseAustrianPostResponse(payload, NUMBER)).toThrow('incomplete scan');
  });

  it('deduplicates scans and keeps unfamiliar stages unresolved', () => {
    const payload = fixture();
    payload.data.einzelsendung.status = 'NEW';
    payload.data.einzelsendung.sendungsEvents.push({ ...payload.data.einzelsendung.sendungsEvents[4] });
    payload.data.einzelsendung.sendungsEvents[0].status = 'NEW';
    payload.data.einzelsendung.sendungsEvents[0].trackingDesc = 'New milestone';
    expect(parseAustrianPostResponse(payload, NUMBER)).toMatchObject({ status: 'unknown', events: expect.any(Array) });
    expect(parseAustrianPostResponse(payload, NUMBER).events).toHaveLength(5);
    expect(parseAustrianPostResponse(payload, NUMBER).events?.[4]).not.toHaveProperty('stage');
  });

  describe('delivery estimate', () => {
    // Out for delivery since 13:00 on 28 March, Vienna time (CET).
    const outForDelivery = (estimatedDelivery: unknown, summary = 'IZ') => {
      const payload = fixture();
      payload.data.einzelsendung.status = summary;
      payload.data.einzelsendung.sendungsEvents = payload.data.einzelsendung.sendungsEvents.slice(0, 3);
      payload.data.einzelsendung.estimatedDelivery = estimatedDelivery;
      return payload;
    };
    const day = { startDate: '2026-03-28T00:00:00', endDate: '2026-03-28T00:00:00', startTime: null, endTime: null };
    const window = { ...day, startTime: '2026-03-28T13:00:00.000+01:00', endTime: '2026-03-28T17:00:00.000+01:00' };

    it('reads the window between its start and end times', () => {
      const result = parseAustrianPostResponse(outForDelivery(window), NUMBER);
      expect(result).toMatchObject({ status: 'out_for_delivery', expected_delivery_from: '2026-03-28T13:00:00+01:00', expected_delivery: '2026-03-28T17:00:00+01:00' });
    });

    it('reads dates as Vienna days, and a range of them', () => {
      expect(parseAustrianPostResponse(outForDelivery(day), NUMBER)).toMatchObject({ expected_delivery: '2026-03-28' });
      expect(parseAustrianPostResponse(outForDelivery(day), NUMBER)).not.toHaveProperty('expected_delivery_from');
      const midnight = { ...day, startDate: '2026-03-27T23:00:00.000Z', endDate: '2026-03-27T23:00:00.000+00:00' };
      expect(parseAustrianPostResponse(outForDelivery(midnight), NUMBER).expected_delivery).toBe('2026-03-28');
      const range = parseAustrianPostResponse(outForDelivery({ ...day, endDate: '2026-03-30', startTime: null }, 'IV'), NUMBER);
      expect(range).toMatchObject({ status: 'in_transit', expected_delivery_from: '2026-03-28', expected_delivery: '2026-03-30' });
    });

    it('keeps only the days when the times fall on other days', () => {
      const result = parseAustrianPostResponse(outForDelivery({ ...window, startTime: '0001-01-01T13:00:00+01:00' }), NUMBER);
      expect(result.expected_delivery).toBe('2026-03-28');
      expect(result).not.toHaveProperty('expected_delivery_from');
    });

    it('drops an estimate that does not read', () => {
      for (const estimate of [null, 'tomorrow', { ...day, startDate: 'Samstag' }, { ...day, endDate: '2026-03-27T00:00:00' }]) {
        const result = parseAustrianPostResponse(outForDelivery(estimate), NUMBER);
        expect(result.expected_delivery).toBeNull();
        expect(result).not.toHaveProperty('expected_delivery_from');
      }
    });

    it('shows the estimate only where the tracking page does', () => {
      for (const summary of ['AV', 'EB', 'RE', 'ZU']) {
        expect(parseAustrianPostResponse(outForDelivery(window, summary), NUMBER).expected_delivery).toBeNull();
      }
      const reason = (code: string, summary = 'IZ') => {
        const payload = outForDelivery(window, summary);
        payload.data.einzelsendung.sendungsEvents[2].reasontypecode = code;
        return parseAustrianPostResponse(payload, NUMBER).expected_delivery;
      };
      // A missed delivery out for delivery, a delay and a problem to resolve hide it.
      expect([reason('BN'), reason('FL'), reason('NZ')]).toEqual([null, null, null]);
      expect(reason('BN', 'IV')).toBe('2026-03-28T17:00:00+01:00');
    });

    it('drops an estimate a later scan has passed', () => {
      const payload = outForDelivery(window);
      payload.data.einzelsendung.sendungsEvents[2].timestamp = '2026-03-28T16:30:00+00:00';
      expect(parseAustrianPostResponse(payload, NUMBER).expected_delivery).toBeNull();
      const days = outForDelivery({ ...day, endDate: '2026-03-29T00:00:00' });
      days.data.einzelsendung.sendungsEvents[2].timestamp = '2026-03-29T16:30:00+00:00';
      expect(parseAustrianPostResponse(days, NUMBER).expected_delivery).toBe('2026-03-29');
      days.data.einzelsendung.sendungsEvents[2].timestamp = '2026-03-29T22:30:00+00:00';
      expect(parseAustrianPostResponse(days, NUMBER).expected_delivery).toBeNull();
    });
  });

  it('separates summary and scan vocabularies for pickup, returns and delivery', () => {
    expect(austrianPostSummaryStatus('IZ')?.stage).toBe('out_for_delivery');
    expect(austrianPostEventStatus('IZ', 'ZA', '')?.stage).toBe('delivered');
    expect(austrianPostEventStatus('IZ', 'BH', '')?.stage).toBe('failed_attempt');
    expect(austrianPostEventStatus('IZ', 'HO', '')?.stage).toBe('ready_for_pickup');
    expect(austrianPostSummaryStatus('RE')?.stage).toBe('returned');
  });

  it('makes one anonymous bounded query and honors caller cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    await new AustrianPostTracker({ fetcher }).fetch(NUMBER, { budgetMs: 900.5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.post.at/sendungen/sv/graphqlPublic');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    const query = String(JSON.parse(String(init?.body)).query);
    expect(query).toContain(`sendungsnummer: "${NUMBER}"`);
    expect(query).toContain('estimatedDelivery { startDate endDate startTime endTime }');
    // The public page shows the sender only after sign-in; nothing about the recipient either.
    expect(query).not.toContain('shipper');
    expect(query).not.toMatch(/street|postalCode|deliveryAddress/);
    expect(init?.headers).not.toHaveProperty('Authorization');
    const cancelled = AbortSignal.abort();
    await expect(new AustrianPostTracker({ fetcher }).fetch(NUMBER, { signal: cancelled })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unavailable endpoint as an unknown parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    await expect(new AustrianPostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('rejects invalid input before network and exposes recognition for ambiguous digits', async () => {
    expect(normalizeAustrianPostNumber(` ${NUMBER} `)).toBe(NUMBER);
    expect(() => normalizeAustrianPostNumber(`${NUMBER}"}`)).toThrow(InvalidInputError);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(tracker.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });
});
