import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, pageToken } from './adapter.js';
import { normalizeLotCargoNumber, parseLotCargoTracking } from './parser.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered: unknown = JSON.parse(fixture('delivered.json'));
const arrived: unknown = JSON.parse(fixture('arrived.json'));
const token = 'page.token.for.the.lot.cargo.tests';
const page = `<app-root></app-root><script>
      const accessToken = {access_token: "${token}", expires_in: "1200", token_type: "Bearer"};
    </script>`;
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('LOT Cargo air waybills', () => {
  it('takes the 080 prefix with or without a separator, or the serial alone', () => {
    expect(normalizeLotCargoNumber('080-36325940')).toBe('08036325940');
    expect(normalizeLotCargoNumber('080 36325940')).toBe('08036325940');
    expect(normalizeLotCargoNumber('36325940')).toBe('08036325940');
    expect(() => normalizeLotCargoNumber('080-36325941')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeLotCargoNumber('724-36325940')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads the page token, then searches the waybill with it and the tracker key', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(page, { headers: { 'Content-Type': 'text/html' } }))
      .mockResolvedValueOnce(Response.json(delivered));
    const result = await tracker(fetcher).track({ number: '080-36325940' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://cargo-tracking.lot.com/');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://api.lot.com/cargo/parcel/search?awbNumber=08036325940&forCarrier=LO-V2');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-api-key')).toMatch(/^\w{40}$/);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: 'DLV', last_status_text: 'Delivered',
      last_update_local: '2022-04-11T19:55',
    });
  });

  it('keeps the order LOT received the messages and each station’s wall clock', () => {
    const { events = [] } = parseLotCargoTracking(delivered, '08036325940');
    expect(events[0]).toMatchObject({ provider_code: 'DLV', location: 'JFK', local_time: '2022-04-11T19:55', stage: 'delivered' });
    const departure = events.findIndex(event => event.provider_code === 'DEP' && event.location === 'WAW');
    const arrival = events.findIndex(event => event.provider_code === 'ARR' && event.location === 'JFK');
    // JFK's arrival clock reads earlier than Warsaw's departure clock, but came later.
    expect(events[arrival]!.local_time! < events[departure]!.local_time!).toBe(true);
    expect(arrival).toBeLessThan(departure);
    expect(events.at(-1)).toMatchObject({ provider_code: 'KK', description: 'Booked', location: 'OTP', stage: 'registered' });
    expect(events.find(event => event.description === 'Planned For Flight')).toMatchObject({ location: 'WAW' });
    expect(events.find(event => event.description === 'Planned For Flight')).not.toHaveProperty('stage');
    expect(events.some(event => event.time)).toBe(false);
    const keys = events.map(event => JSON.stringify([event.provider_code, event.description, event.local_time, event.location]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves an arrived waybill ready for its consignee until LOT records the delivery', () => {
    expect(parseLotCargoTracking(arrived, '08036272121')).toMatchObject({
      current_stage: 'ready_for_pickup', provider_code: 'AWD',
      last_status_text: 'Arrival documents delivered to Consignee/Agent', last_update_local: '2022-03-27T12:18',
    });
  });

  it('requires the requested waybill before reading its history', () => {
    expect(() => parseLotCargoTracking(delivered, '08036272121')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports a waybill LOT does not know as not found', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(page))
      .mockResolvedValueOnce(new Response(fixture('not-found.json'), { status: 404 }));
    await expect(tracker(fetcher).track({ number: '080-97850196' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not take a refused key or a verification page for a missing waybill', async () => {
    const refused = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(page))
      .mockResolvedValueOnce(Response.json({ message: 'Invalid Authorization Token', code: 11 }, { status: 401 }));
    await expect(tracker(refused).track({ number: '080-36325940' })).rejects.toMatchObject({ kind: 'schema' });
    const challenged = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<html><head><title>Access Denied</title></head></html>', { status: 403 }));
    await expect(tracker(challenged).track({ number: '080-36325940' })).rejects.toMatchObject({ kind: 'challenge' });
    expect(challenged).toHaveBeenCalledTimes(1);
    expect(() => pageToken('<title>Access Denied</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => pageToken('<app-root></app-root>')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
