import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LERDEX_API, LERDEX_KEY, LerdexTracker } from './adapter.js';
import { lerdexWording, normalizeLerdexNumber, parseLerdex } from './parser.js';
import { lerdexStage, statusMap } from './status.js';

const NUMBER = 'TDOXP3121520012YQ';
const UNKNOWN = 'TDOXP0000000000YQ';
const fixture = (name: 'delivered' | 'not-found') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('Lerdex tracking page lookup', () => {
  it('posts the whole number with the page key through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new LerdexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tdoxp 3121520012 yq ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(LERDEX_API);
    expect(JSON.parse(String(init!.body))).toEqual({ numbers: [NUMBER] });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { tk: LERDEX_KEY, 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'lerdex', step: 'direct', outcome: 'ok' }));
  });

  it('reads the delivered sample with its places split from the wording and the YunExpress waybill', () => {
    const result = parseLerdex(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered, Front Door/Porch',
      last_update: null, last_update_local: '2025-12-31T11:02:00', destination_country: 'US',
      delivery_carrier: 'yunexpress', delivery_tracking_number: 'YT2534600711134963' });
    expect(result.events).toHaveLength(28);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![0]).toMatchObject({ location: 'DELANO, MN', description: 'Delivered, Front Door/Porch', stage: 'delivered' });
    expect(result.events![8]).toMatchObject({ location: 'GLENDALE HEIGHTS, IL', description: 'Departed Shipping Partner Facility, USPS Awaiting Item' });
    expect(result.events![16]).toMatchObject({ location: 'Mainland China, CN', description: 'Shipment is in transit to next facility' });
    expect(result.events!.find((event) => event.description === 'received Shipment.')).toMatchObject({ stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2025-12-13T01:30:00', stage: 'registered' });
    expect(result.events!.at(-1)).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/55328|55131|60139/);
  });

  it('splits a place only where a comma without a space joins it to the wording', () => {
    expect(lerdexWording({ content: 'Clearance processing completed - Import' })).toEqual({ description: 'Clearance processing completed - Import', location: '' });
    expect(lerdexWording({ content: 'US,International flight has arrived' })).toEqual({ description: 'International flight has arrived', location: 'US' });
    expect(lerdexWording({ content: 'Delivered, signed by J. SAMPLE' })).toEqual({ description: 'Delivered', location: '' });
    expect(lerdexWording({ location: 'LOS ANGELES', content: 'Arrived' })).toEqual({ description: 'Arrived', location: 'LOS ANGELES' });
  });

  it('reads the all-null entry as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseLerdex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLerdex(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLerdex(changed((r) => { r.data[0].number = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLerdex(changed((r) => { r.data.push(r.data[0]); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLerdex(changed((r) => { r.code = 500; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLerdex(changed((r) => { r.data[0].events = null; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseLerdex(changed((r) => { r.data[0].events = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseLerdex(changed((r) => { r.data[0].events[0].time = '2025-12-31'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: unknown, init?: ResponseInit) => new LerdexTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(fixture('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps the line number without naming a carrier it cannot place', () => {
    const other = parseLerdex(changed((r) => { r.data[0].oriChannel = 'Some Line'; r.data[0].oriNumber = 'AB123456789'; }), NUMBER);
    expect(other.delivery_tracking_number).toBe('AB123456789');
    expect(other.delivery_carrier).toBeUndefined();
    expect(parseLerdex(changed((r) => { r.data[0].oriNumber = NUMBER; }), NUMBER).delivery_tracking_number).toBeUndefined();
  });

  it('accepts the number shape only, without a request', async () => {
    expect(normalizeLerdexNumber('tdoxp3121520012yq')).toBe(NUMBER);
    for (const number of ['3121520012', 'TDOXP', 'TDOXP3121520012YQXX', '1Z999AA10123456784']) {
      expect(() => normalizeLerdexNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new LerdexTracker({ fetcher }).fetch('3121520012')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'lerdex', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the warehouse wordings', () => {
    expect(lerdexStage('received Shipment.')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(lerdexStage('Out for Delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(statusMap.stage(null, 'item Despatched To Transshipment Hub.')).toBe('in_transit');
  });
});
