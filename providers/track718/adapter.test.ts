import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { priorityUniversalSource, universalPlan } from '../plan.js';
import { adapter, juxiNumber, parseTrack718, TRACK718_API } from './adapter.js';

const number = 'JXCZZ9999999980YQ';
const row = () => ({ track: number, fromKey: 'www.juxiex.com', result: 40, origin: '01', isMerge: false,
  from: [{ ondate: '2031-03-04T12:30:00+08:00', status: 'Shipment picked up', address: 'Example City' }],
  to: [{ ondate: '2031-03-06T10:20:00-05:00', status: 'Delivered', address: 'Test City' }], frist: [], wms: [] });
const found = () => ({ status: { code: 0 }, data: [row()], pending: false });
const capture = (payload: unknown) => ({ url: TRACK718_API, status: 200, body: JSON.stringify(payload),
  headers: {}, trackingNumberSubmitted: number, error: null, truncated: false, base64Encoded: false });

describe('Track718 for Juxi only', () => {
  it('preserves provenance and source offsets without leaking unrelated fields', () => {
    const payload = found();
    const answer = parseTrack718([payload], number);
    expect(answer).toMatchObject({ tracking_provider: 'Track718', current_stage: 'delivered',
      events: [{ time: '2031-03-06T10:20:00-05:00' }, { time: '2031-03-04T12:30:00+08:00' }] });
    expect(juxiNumber(number.toLowerCase(), 'juxi-express')).toBe(number);
    expect(() => juxiNumber(number, 'china-post')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => juxiNumber('YT900000000001')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    const local = found(); local.data[0]!.from[0]!.ondate = '2031-03-04 12:30:00';
    expect(parseTrack718([local], number).events!.at(-1)).toMatchObject({ local_time: '2031-03-04T12:30:00' });
  });

  it('counts distinct scans across repeated snapshots', () => {
    const payload = found();
    payload.data[0]!.from = Array.from({ length: 340 }, (_, i) => ({
      ...row().from[0]!, ondate: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
    }));
    expect(parseTrack718([payload], number).history_truncated).toBe(true);
    expect(parseTrack718([payload, payload, payload], number).events).toHaveLength(100);
  });

  it('bounds snapshot count, snapshot size and distinct scans independently', () => {
    const payload = found();
    expect(() => parseTrack718(Array(9).fill(payload), number)).toThrow('too many snapshots');
    payload.data[0]!.from = Array(500).fill(row().from[0]);
    expect(() => parseTrack718([payload], number)).toThrow('invalid scans');
    const snapshots = Array.from({ length: 3 }, (_, snapshot) => {
      const item = found();
      item.data[0]!.from = Array.from({ length: 340 }, (_, i) => ({ ...row().from[0]!, status: `Scan ${snapshot}-${i}` }));
      return item;
    });
    expect(() => parseTrack718(snapshots, number)).toThrow('too many scans');
  });

  it('waits for a completed reply and never calls a queued lookup missing', () => {
    const empty = { ...row(), result: 0, from: [], to: [], origin: '04' };
    expect(() => parseTrack718([{ status: { code: 3 }, data: [empty], pending: true }], number))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTrack718([{ status: { code: 0 }, data: [empty], pending: false }], number))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = found(); other.data[0]!.track += '0';
    expect(() => parseTrack718([other], number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const carrier = found(); carrier.data[0]!.fromKey = 'another.example';
    expect(() => parseTrack718([carrier], number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const [code, kind] of [[2, 'challenge'], [5, 'rate_limited'], [6, 'indeterminate'], [8, 'challenge']] as const) {
      expect(() => parseTrack718([{ status: { code } }], number)).toThrow(expect.objectContaining({ kind }));
    }
    expect(parseTrack718([{ ...found(), pending: true }], number).history_truncated).toBe(true);
    expect(() => parseTrack718([found(), { status: { code: 2 } }], number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('binds the browser service, budget and signal to Juxi and makes no unrelated lookup', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture(found())] })));
    const provider = adapter({ env: {}, fetcher, trawl: new TrawlClient('http://browser.test', fetcher), recorder: NOOP_RECORDER, browserExecutablePath: null });
    await expect(provider.track({ number, carrier: 'juxi-express' }, { budgetMs: 9000 })).resolves.toMatchObject({ tracking_provider: 'Track718' });
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request).toMatchObject({ url: `https://www.track718.com/en/detail?nums=${number}&cb=678`, captureResponses: [TRACK718_API] });
    expect(request.maxTimeout).toBeLessThanOrEqual(7000);
    expect(fetcher.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    await expect(provider.track({ number, carrier: 'ups' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('asks Track718 for Juxi after the providers that answer, and for no other carrier', () => {
    expect(universalPlan({ carriers: ['juxi-express'], trackingNumber: number }).sources).toEqual(['ParcelsApp', 'Ship24', '17TRACK', 'Track718']);
    expect(universalPlan({ trackingNumber: number }).sources).toEqual(['ParcelsApp', 'Ship24', '17TRACK', 'Track718']);
    expect(universalPlan({ carriers: ['juxi-express'], trackingNumber: number, enablePostalNinja: true }).sources).toEqual(['ParcelsApp', 'Ship24', '17TRACK', 'Track718']);
    expect(priorityUniversalSource(number)).toBeUndefined();
    expect(universalPlan({ carriers: ['ups'], trackingNumber: number }).sources).not.toContain('Track718');
    expect(universalPlan({ carriers: ['ups', 'juxi-express'], trackingNumber: number }).sources).not.toContain('Track718');
    expect(universalPlan({ trackingNumber: 'YT900000000001' }).sources).toContain('17TRACK');
    expect(universalPlan().sources).not.toContain('Track718');
  });
});
