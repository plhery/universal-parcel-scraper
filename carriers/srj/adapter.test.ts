import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SRJ_API, SRJ_SITE, SrjTracker, srjLookupUrl } from './adapter.js';
import { normalizeSrjNumber, parseSrj, srjRow } from './parser.js';
import { srjStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'LBG99999999999';
// After the sample's newest row, on Shanghai's clock.
const READ_AT = Date.parse('2026-11-26T12:00:00+08:00');
const raw = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('SRJ tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 3).toLowerCase()} ${NUMBER.slice(3, 9)}-${NUMBER.slice(9)}`;
    const result = await new SrjTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(srjLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(SRJ_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: SRJ_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'srj', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, with wall clocks, USPS as the delivering carrier and its places', () => {
    const result = parseSrj(raw('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, In/At Mailbox', last_update: null, last_update_local: '2026-05-21T12:29',
      expected_delivery: null, destination_country: 'US', weight_kg: 0.488,
      delivery_carrier: 'usps', delivery_tracking_number: '9235990374019712932717' });
    const events = result.events!;
    expect(events).toHaveLength(17);
    expect(events.every((event) => !event.time && event.local_time)).toBe(true);
    // The tracker lists its rows out of order; the clocks put them back, equal ones newest first as listed.
    const clocks = events.map((event) => event.local_time as string);
    expect(clocks).toEqual([...clocks].sort().reverse());
    expect(events.slice(12, 14).map((event) => event.description)).toEqual(['Leave Processing Center', 'Arrive Processing Center']);
    expect(events[0]).toEqual({ local_time: '2026-05-21T12:29', location: 'MC NABB, IL, US', description: 'Delivered, In/At Mailbox',
      provider_code: 'LD', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[1]).toMatchObject({ description: 'Out for Delivery', provider_code: 'BD', stage: 'out_for_delivery' });
    expect(events[7]).toMatchObject({ location: 'FRANKLIN PARK, IL, US', description: 'Accepted at USPS Origin Facility',
      provider_code: 'PU', stage: 'in_transit' });
    // A row dated by its day alone keeps that day, after the timed rows of its day.
    expect(events[8]).toEqual({ local_time: '2026-05-13', description: 'Operation center out of warehouse', stage: 'in_transit',
      stage_source: 'carrier_map' });
    expect(events[9]).toMatchObject({ location: 'US', description: 'Cargo is being transshipped locally', provider_code: 'OT' });
    expect(events.find((event) => event.description === 'Import clearance start')).toMatchObject({ stage: 'customs' });
    expect(events.at(-1)).toMatchObject({ local_time: '2026-04-20T14:47', description: 'Shipment Information Received',
      provider_code: 'RC', stage: 'registered' });
    // The inner number, USPS's sentence and the recipient's ZIP code stay out.
    expect(JSON.stringify(result)).not.toMatch(/2026042014471763269475|Your item|61335/);
  });

  it('splits only the rows the line relays', () => {
    expect(srjRow('Delivered,MC NABB, IL, US,Delivered, Front Door/Porch -> Your item was delivered.[LD]'))
      .toEqual({ description: 'Delivered, Front Door/Porch', location: 'MC NABB, IL, US', code: 'LD' });
    expect(srjRow('US,Cargo is being transshipped locally[OT]')).toEqual({ description: 'Cargo is being transshipped locally', location: 'US', code: 'OT' });
    expect(srjRow('Shipment Information Received[RC]')).toEqual({ description: 'Shipment Information Received', location: '', code: 'RC' });
    expect(srjRow('Sorted,then dispatched[OS]')).toEqual({ description: 'Sorted,then dispatched', location: '', code: 'OS' });
    expect(srjRow('The Shipment information received')).toEqual({ description: 'The Shipment information received' });
  });

  it('reads the record\'s delivered state, and a delivery number only when another carrier\'s rules claim it whole', () => {
    const withoutDelivery = changed(/<DATETIME>2026-05-21 12:29<\/DATETIME>.*\r?\n/, '');
    expect(parseSrj(withoutDelivery, NUMBER, READ_AT)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      current_stage_source: 'carrier_map', last_status_text: 'Out for Delivery' });
    expect(parseSrj(withoutDelivery.replace('<STATE>3', '<STATE>1'), NUMBER, READ_AT))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    for (const reference of ['', NUMBER, 'A-SE NOTE', '12345678']) {
      const result = parseSrj(changed('<REFER_NBR>9235990374019712932717', `<REFER_NBR>${reference}`), NUMBER, READ_AT);
      expect(result, reference).not.toHaveProperty('delivery_carrier');
      expect(result, reference).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('leaves out a row dated after the lookup on the forwarder\'s clock, a day alone included', () => {
    const result = parseSrj(raw('delivered'), NUMBER, Date.parse('2026-05-13T00:30:00+08:00'));
    expect(result.last_update_local).toBe('2026-05-13');
    expect(parseSrj(raw('delivered'), NUMBER, Date.parse('2026-05-12T23:30:00+08:00')).last_update_local).toBe('2026-05-11T15:54');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseSrj(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSrj(raw('delivered'), 'LBG26042000399', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSrj(changed(/^100/, '-1'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSrj(changed('<DATETIME>2026-05-13<', '<DATETIME>2026-05-32<'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSrj(changed('<DATETIME>2026-05-13<', '<DATETIME>2026-05-13 25:00<'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSrj(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new SrjTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(raw('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://huayu-ex.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeSrjNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['LBG123', 'LBGABCDEFGHIJK', `LBG${'1'.repeat(30)}`, 'LBG2604/2000398', '']) {
      expect(() => normalizeSrjNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SrjTracker({ fetcher }).fetch('LBG123')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new SrjTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'srj', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the rows by code and wording, else by the shared wording rules', () => {
    expect(srjStage('Arrived at Post Office', 'TR')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(srjStage('Accepted at USPS Origin Facility', 'PU')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(srjStage('Delivered, Front Door/Porch', 'LD')).toMatchObject({ stage: 'delivered' });
    expect(srjStage('Operation center out of warehouse')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage('BD', 'out for delivery')).toBe('out_for_delivery');
    expect(statusMap.stage('OT', 'import clearance start')).toBe('customs');
    expect(statusMap.stage(null, 'import clearance start')).toBeUndefined();
  });
});
