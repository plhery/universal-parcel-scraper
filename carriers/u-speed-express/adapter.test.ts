import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { itdidaLookupUrl } from '../whwdt/itdida.js';
import { adapter, USpeedTracker } from './adapter.js';
import { normalizeUSpeedNumber, parseUSpeed, U_SPEED_HOST } from './parser.js';
import { statusMap, uSpeedStage } from './status.js';

const NUMBER = 'RUN10001202229377';
const UNKNOWN = 'RUN10009999999917';
const fixture = (name: 'delivered' | 'not-found') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, ...init });

describe('U-Speed Express ITDIDA tenant', () => {
  it('asks the tenant on the forwarder\'s own domain for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new USpeedTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' run1000-1202-2293-77 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.u-speedex.com/itdida-api/queryTracks?no=${NUMBER}`);
    expect(String(url)).toBe(itdidaLookupUrl(U_SPEED_HOST, NUMBER));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'u-speed-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads the delivered sample on wall clocks, without the text messages or the status names as places', () => {
    const result = parseUSpeed(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered（999）', last_update: null, last_update_local: '2022-11-24T12:04:29', expected_delivery: null,
      destination_country: 'IL' });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.events).toHaveLength(12);
    expect(result.events!.every((event) => event.local_time && !event.time && !event.location)).toBe(true);
    expect(result.events!.map((event) => event.description)).toEqual(['Delivered（999）', 'Delivered', 'Delivered', 'Out for delivery',
      'Arrived to Sorting Center', 'Customs cleared', 'Pre-Clearance process', 'Pre-Clearance process', 'Pre-Clearance process',
      'Import of Record Received', 'The system has accepted the order（101）', 'ORDER RECEIVED BY TRUCKER']);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2022-11-17T09:08:00', stage: 'registered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/sms|removed|G-C|סגור|חדש|[֐-׿]/i);
  });

  it('leaves the rows on Israel\'s clock for a consumer, by the parcel\'s destination', () => {
    const events = dateLocalClocks('u-speed-express', parseUSpeed(fixture('delivered'), NUMBER)).events!;
    expect(events.every((event) => event.time_zone === 'Asia/Jerusalem' && event.time_zone_basis === 'destination')).toBe(true);
    expect(events[0]).toMatchObject({ time: '2022-11-24T12:04:29+02:00' });
  });

  it('drops any text message, whatever its case, and keeps a place the partner names', () => {
    const result = parseUSpeed(changed((r) => {
      r.data[0].trackList[3].localtion = 'SMS';
      r.data[0].trackList[3].desc = 'Synthetic message to Example Person';
      r.data[0].trackList[6].localtion = 'Modiin';
    }), NUMBER);
    expect(result.events!.some((event) => /Example Person/.test(event.description!))).toBe(false);
    expect(result.events!.find((event) => event.description === 'Arrived to Sorting Center')).toMatchObject({ location: 'Modiin' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseUSpeed(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseUSpeed(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUSpeed(changed((r) => { r.data[0].no = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUSpeed(changed((r) => { r.data[0].errorMsg = '查询过于频繁'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUSpeed(changed((r) => { r.success = false; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUSpeed(changed((r) => { r.data[0].trackList = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A reply holding only text messages has no scan of the parcel.
    expect(() => parseUSpeed(changed((r) => { r.data[0].trackList = r.data[0].trackList.filter((row: { localtion: string }) => row.localtion === 'sms'); }), NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseUSpeed(changed((r) => { r.data[0].trackList[0].time = '2022-11-24 24:00:00'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: unknown, init?: ResponseInit) => new USpeedTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(fixture('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.u-speedex.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ data: 'too busy', statusCode: 503, success: false }, { status: 503 })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('<html>503 Service Temporarily Unavailable</html>', { status: 503 })).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('accepts the numbers the lookup takes, without a request for anything else', async () => {
    expect(normalizeUSpeedNumber('run10001202229377')).toBe(NUMBER);
    expect(normalizeUSpeedNumber('USP20221115')).toBe('USP20221115');
    for (const number of ['RUN1', 'ABCDEFGHIJ', `RUN${'1'.repeat(40)}`, 'RUN1000/1202']) {
      expect(() => normalizeUSpeedNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new USpeedTracker({ fetcher }).fetch('RUN1')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'u-speed-express', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the partner\'s wordings by its own map, then the shared rules', () => {
    expect(uSpeedStage('The system has accepted the order（101）')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(uSpeedStage('Import of Record Received')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(uSpeedStage('Out for Delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(statusMap.stage(null, 'order received by trucker')).toBe('registered');
  });
});
