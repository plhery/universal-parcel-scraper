import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, QINHANG_API, QINHANG_SITE, QinhangTracker, qinhangLookupUrl } from './adapter.js';
import { normalizeQinhangNumber, parseQinhang, qinhangHandoff, qinhangRow, qinhangZone } from './parser.js';
import { qinhangStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'QH99999999';
// After the sample's newest row, on Shanghai's clock.
const READ_AT = Date.parse('2026-11-27T12:00:00+08:00');
const bytes = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));
// The server answers in GBK.
const raw = (name: 'delivered' | 'not-found') => new TextDecoder('gb18030').decode(bytes(name));
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('Qinhang Transportation tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport, and reads its GBK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 2).toLowerCase()} ${NUMBER.slice(2, 6)}-${NUMBER.slice(6)}`;
    const result = await new QinhangTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', destination_country: 'US', delivery_carrier: 'abf-freight' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(qinhangLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(QINHANG_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: QINHANG_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'qinhang-transportation', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, on China\'s clock, with ArcBest as the delivering carrier', () => {
    const result = parseQinhang(raw('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '6.24, delivered', last_update: '2025-06-24T11:09:00+08:00', last_update_local: '2025-06-24T11:09',
      expected_delivery: null, destination_country: 'US', weight_kg: 609,
      delivery_carrier: 'abf-freight', delivery_tracking_number: '087726987' });
    const events = result.events!;
    expect(events).toHaveLength(10);
    expect(events.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier')).toBe(true);
    const times = events.map((event) => Date.parse(event.time!));
    expect(times).toEqual([...times].sort((left, right) => right - left));
    expect(events[0]).toEqual({ time: '2025-06-24T11:09:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2025-06-24T11:09', description: '6.24, delivered', stage: 'delivered', stage_source: 'carrier_map' });
    // The hand-off row: its midnight clock as the reader reads it, its wording without the trucking firm's phone.
    expect(events[1]).toEqual({ time: '2025-06-11T00:00:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2025-06-11T00:00:00',
      description: `Hello, tracking number and tracking website, please find the original single: ${NUMBER} tracking number: 087 726 987 tracking website: https://arcb.com/tools/tracking.html#`,
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events[2]).toMatchObject({ location: 'Shenzhen', description: 'The container has been picked up and unpacked, awaiting sorting and ordering',
      stage: 'in_transit' });
    expect(events.find((event) => event.description?.startsWith('It has arrived at the port'))).toMatchObject({ stage: 'customs' });
    expect(events.find((event) => event.description?.startsWith('Container loaded on'))).toMatchObject({ stage: 'in_transit' });
    expect(events.at(-2)).toMatchObject({ description: 'Receiving scan', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ time: '2025-03-22T17:03:09+08:00', location: 'Shenzhen', description: 'Pre-forecast',
      stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/555-0100|telephone|Please call/i);
  });

  it('leaves out the contact details a row ends with', () => {
    expect(qinhangRow('tracking website: https://arcb.com/ card company telephone: Please call (800) 555-0100 for your company'))
      .toEqual({ description: 'tracking website: https://arcb.com/' });
    expect(qinhangRow('Delivery booked, phone 555-0100')).toEqual({ description: 'Delivery booked' });
    expect(qinhangRow('Delivery booked, please call (800) 555-0100')).toEqual({ description: 'Delivery booked' });
    expect(qinhangRow('已派送，联系电话13800000000')).toEqual({ description: '已派送' });
    expect(qinhangRow('Receiving scan')).toEqual({ description: 'Receiving scan' });
    expect(qinhangRow('The ship set sail on April 7, 2025/04/7')).toEqual({ description: 'The ship set sail on April 7, 2025/04/7' });
  });

  it('dates a row on China\'s clock unless its place is a US town in a state of one clock', () => {
    expect(qinhangZone('Shenzhen')).toEqual({ zone: 'Asia/Shanghai', basis: 'carrier' });
    expect(qinhangZone('')).toEqual({ zone: 'Asia/Shanghai', basis: 'carrier' });
    expect(qinhangZone('SAVANNAH, GA')).toEqual({ zone: 'America/New_York', basis: 'place' });
    expect(qinhangZone('Los Angeles, CA, US')).toEqual({ zone: 'America/Los_Angeles', basis: 'place' });
    // A state of several clocks does not settle the row's: it keeps its wall clock alone.
    expect(qinhangZone('Houston, TX')).toBeNull();
    const placed = changed('<PLACE></PLACE><INFO>6.24, delivered', '<PLACE>SAVANNAH, GA</PLACE><INFO>6.24, delivered');
    expect(parseQinhang(placed, NUMBER, READ_AT).events![0]).toMatchObject({ time: '2025-06-24T11:09:00-04:00',
      time_zone: 'America/New_York', time_zone_basis: 'place', location: 'SAVANNAH, GA' });
  });

  it('names ArcBest only with its tracking site and a PRO number other than the waybill', () => {
    const result = (description: string) => ({ events: [{ description }] });
    expect(qinhangHandoff(result('tracking number: 087 726 987 tracking website: https://arcb.com/tools/tracking.html#'), NUMBER))
      .toEqual({ delivery_carrier: 'abf-freight', delivery_tracking_number: '087726987' });
    for (const description of ['tracking number: 087 726 987 tracking website: https://example.com/', 'tracking website: https://arcb.com/',
      'tracking number: 0877269871 tracking website: https://arcb.com/', `tracking number: ${NUMBER} tracking website: https://arcb.com/`]) {
      expect(qinhangHandoff(result(description), NUMBER), description).toEqual({});
    }
    const withoutRow = changed(/<DATETIME>2025-06-11 00:00:00<\/DATETIME>.*\r?\n/, '');
    expect(parseQinhang(withoutRow, NUMBER, READ_AT)).not.toHaveProperty('delivery_carrier');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseQinhang(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseQinhang(raw('delivered'), 'QH25032224', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQinhang(changed(/^100/, '-1'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseQinhang(changed('<DATETIME>2025-05-16 ', '<DATETIME>2025-05-32 '), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQinhang(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new QinhangTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new QinhangTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.qinhang56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeQinhangNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['QH123', 'QHABCDEFGH', `QH${'1'.repeat(30)}`, 'QH2503/2223', '']) {
      expect(() => normalizeQinhangNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new QinhangTracker({ fetcher }).fetch('QH123')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new QinhangTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'qinhang-transportation', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the rows by their wording, with the notes\' dates and names as any text', () => {
    expect(qinhangStage('Pre-forecast')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(qinhangStage('Container loaded on 2026/01/02 expected to depart: 2026/01/09')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(qinhangStage('It has arrived at the port on June 3rd and is awaiting unloading and customs clearance')).toMatchObject({ stage: 'customs' });
    expect(qinhangStage('7.1, delivered')).toMatchObject({ stage: 'delivered' });
    expect(statusMap.stage(null, 'the container has been picked up and unpacked, awaiting sorting and ordering')).toBe('in_transit');
    expect(statusMap.stage(null, 'receiving scan')).toBe('accepted');
    expect(statusMap.stage('X', 'receiving scan')).toBeUndefined();
  });
});
