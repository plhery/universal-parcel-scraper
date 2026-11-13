import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { createTracker } from '../../facade/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, GLS_US_ENDPOINT, GlsUsTracker } from './adapter.js';
import { normalizeGlsUsNumber, parseGlsUs } from './parser.js';
import { glsUsShipmentStatus, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'SH730418265903174526';
const UNKNOWN = 'SH730418265903179913';

type Row = Record<string, unknown>;
type Shipment = Row & { transitDetails: Row[] };
type Reply = Row & { shipments: Shipment[] };

const body = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(body(name)) as Reply;
const changed = (change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture('delivered');
  change(reply.shipments[0]!, reply);
  return reply;
};
// The delivered parcel's state while it was out for delivery: its two newest rows not written yet.
const outForDelivery = () => changed((shipment) => {
  shipment.status = 'out for delivery';
  shipment.transitDetails.shift();
});
const reply = (payload: unknown, init: ResponseInit = {}) => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GLS US HTTP adapter', () => {
  it("posts the whole number as the tracking page does, through the supplied transport", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GlsUsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' sh7304 1826 5903 174526 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(GLS_US_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Language': 'en-CA',
      Origin: 'https://gls-group.com', Referer: 'https://gls-group.com/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init.body))).toEqual({ trackingNumbers: NUMBER, isFreight: false });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gls-us', step: 'direct', outcome: 'ok' }));
  });

  it('keeps every scan on its wall clock, with its place and the stage its wording gives', () => {
    const result = parseGlsUs(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SHIPMENT DELIVERED', last_update: null, last_update_local: '2026-03-05T14:21:09', expected_delivery: null });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-03-05T14:21:09', 'SHIPMENT DELIVERED', 'Sample City, CA, US', 'delivered'],
      ['2026-03-05T08:12:44', 'ON ROUTE FOR DELIVERY', 'OTHERTOWN, CA, US', 'out_for_delivery'],
      ['2026-03-05T06:40:02', 'SCANNED AT DELIVERY DEPOT', 'OTHERTOWN, CA, US', 'in_transit'],
      ['2026-03-04T19:03:55', 'ARRIVAL SCAN - DELIVERY SCHED FOR 03/05/2026', 'SAMPLEVILLE, CA, US', 'in_transit'],
      ['2026-03-04T10:15:30', 'LABEL CREATED', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('gives the estimate while the parcel moves, and none once it is delivered or unset', () => {
    expect(parseGlsUs(outForDelivery(), NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'ON ROUTE FOR DELIVERY', expected_delivery: '2026-03-05' });
    const unset = outForDelivery();
    unset.shipments[0]!.estimatedDeliveryDate = '0001-01-01T00:00:00';
    expect(parseGlsUs(unset, NUMBER).expected_delivery).toBeNull();
  });

  it("reads the shipment's own status before its newest scan, and the scans when the status is new to it", () => {
    expect(parseGlsUs(changed((shipment) => { shipment.status = 'returned'; }), NUMBER))
      .toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
    expect(parseGlsUs(changed((shipment) => { shipment.status = 'Synthetic status'; }), NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(glsUsShipmentStatus('In Transit')).toEqual({ status: 'in_transit', stage: 'in_transit' });
  });

  it('lets a scan further along lead a status that lags it, and no other', () => {
    expect(parseGlsUs(changed((shipment) => { shipment.status = 'out for delivery'; }), NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    expect(parseGlsUs(changed((shipment) => {
      shipment.status = 'in transit';
      shipment.transitDetails.shift();
    }), NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(parseGlsUs(outForDelivery(), NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(parseGlsUs(changed((shipment) => {
      shipment.status = 'delivered';
      shipment.transitDetails.shift();
    }), NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('answers a label without scans by its status alone', () => {
    const result = parseGlsUs(changed((shipment) => {
      shipment.status = 'label created';
      shipment.transitDetails = [];
    }), NUMBER);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'label created', summary_only: true, events: [] });
    expect(() => parseGlsUs(changed((shipment) => {
      shipment.status = '';
      shipment.transitDetails = [];
    }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('never reads the recipient, the signer or the shipper’s reference', () => {
    const result = parseGlsUs(changed((shipment) => Object.assign(shipment, {
      deliveryCompany: 'Sample Company', deliveryContact: 'Sample Person', signedBy: 'Sample Signer', reference: 'SAMPLE-REF-1',
      deliveryAddress: { company: 'Sample Company', city: 'Sample City', state: 'CA', country: 'US', zip: '00000' },
      hasPodImage: true, hasSignatureImage: true, controlNumber: 123, stopId: 456,
    })), NUMBER);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Company|Person|Signer)|SAMPLE-REF|00000|123|456/);
  });

  it('reads only the service’s unknown-number answer as not found, and binds the reply to the whole number', () => {
    expect(() => parseGlsUs(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found', provider: 'GLS US' }));
    expect(() => parseGlsUs({ ...fixture('not-found'), message: 'Synthetic failure' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGlsUs({ shipments: null, message: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGlsUs(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlsUs(changed((shipment) => { shipment.trackingNumber = NUMBER.slice(0, -1); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlsUs({ shipments: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlsUs(changed((shipment) => { shipment.transitDetails[0]!.eventDateTime = '0001-01-01T00:00:00'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes the shipment with the newest scan when the number was used twice, and no shipment when they tie', () => {
    const older = changed((shipment) => {
      shipment.status = 'in transit';
      shipment.transitDetails = shipment.transitDetails.slice(3).map((row) => ({ ...row, eventDateTime: String(row.eventDateTime).replace('2026-03', '2025-11') }));
    }).shipments[0]!;
    const twice = fixture('delivered');
    twice.shipments.unshift(older);
    expect(parseGlsUs(twice, NUMBER)).toMatchObject({ status: 'delivered', last_update_local: '2026-03-05T14:21:09' });
    const tie = fixture('delivered');
    tie.shipments.push({ ...tie.shipments[0]!, status: 'in transit' });
    expect(() => parseGlsUs(tie, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a moved route, a block page, an empty reply and a broken reply apart from an unknown number', async () => {
    const lookup = (payload: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(payload, init))).track({ number: UNKNOWN });
    await expect(lookup(body('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(body('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://gls-group.com/US/en/home/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Access denied</title><body>The request is blocked.</body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Synthetic error</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"shipments":[')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    });

  it('rejects what the tracking page would not take, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SH12', 'SH7304182659031745261', `SH${'0'.repeat(70)}`, 'SH73041826590317452,1']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    // A number the page would not take says so, cancelled or not.
    await expect(carrier(fetcher).track({ number: 'SH12' }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGlsUsNumber('sh 7304-1826 5903 174526')).toBe(NUMBER);
  });

  it('sends a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed, linked or detected under GLS US to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: NUMBER, carrier: 'gls-us' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gls-us', source: 'gls-us', result: { status: 'delivered' } });
    for (const link of [
      `https://gls-group.com/US/en/send-and-receive/track-a-parcel/?TrackingNumbers=${NUMBER}`,
      `https://www.gls-us.com/track-and-trace?TrackingNumbers=${NUMBER}`,
      `https://www.gso.com/Tracking/PackageDetail?TrackingNumber=${NUMBER}`,
    ]) expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'gls-us', source: 'link' });
    // GLS's European pages keep their own networks.
    expect(parseTrackingInput('https://gls-group.com/DE/de/paketverfolgung?match=12345678901')).not.toMatchObject({ carrier: 'gls-us' });
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ candidates: ['gls-us'] });
  });

  it('is the carrier the providers name GLS US by, apart from GLS’s European networks', () => {
    for (const name of ['GLS (US)', 'GLS US', 'GSO (GLS US)', 'Golden State Overnight']) expect(carrierIdFromName(name), name).toBe('gls-us');
    expect(carrierIdFromName('GLS')).toBeUndefined();
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for what it would not take', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(body('delivered')))
      .mockResolvedValueOnce(reply(body('not-found')));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityLocal: '2026-03-05T14:21:09' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('SH-1')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
    });
});

describe('GLS US status vocabulary', () => {
  it('records every scan wording the map knows with the stage it gives, and the shipment statuses apart', () => {
    for (const entry of statuses.entries as { wording: string; stage: string; note?: string }[]) {
      const shipmentStatus = entry.wording === entry.wording.toLowerCase();
      if (shipmentStatus) {
        expect(glsUsShipmentStatus(entry.wording)?.stage, entry.wording).toBe(entry.stage);
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'gls-us', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage(null, 'arrival scan - delivery sched for 12/31/2026')).toBe('in_transit');
    expect(statusMapAnswer({ carrier: 'gls-us', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
