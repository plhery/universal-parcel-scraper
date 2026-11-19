import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeCarryBeeNumber, parseCarryBee } from './parser.js';
import { statusMap } from './status.js';

// TrackShip's public CarryBee example; fixtures/delivered.json is its live reply.
const NUMBER = 'F0910B74W5Y';
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const fixture = () => load('delivered');
const instance = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CarryBee tracker', () => {
  it('merges the history with the journey steps it lacks, on their stated clocks', () => {
    const result = parseCarryBee(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2025-09-11T14:56:41+06:00', delivered_at: '2025-09-11T14:56:41+06:00',
      expected_delivery: null });
    expect(result.events!.map(event => [event.time, event.description, event.provider_code, event.stage])).toEqual([
      ['2025-09-11T14:56:41+06:00', 'Order has been delivered to the customer', '15', 'delivered'],
      ['2025-09-11T10:04:45+06:00', 'Your parcel is out for delivery', '14', 'out_for_delivery'],
      ['2025-09-11T09:44:59+06:00', 'Received At LMH', 'received_at_lmh', 'in_transit'],
      ['2025-09-11T09:43:29+06:00', 'In Transit', 'in_transit', 'in_transit'],
      ['2025-09-11T08:44:19+06:00', 'Order has been reached at delivery hub', '13', 'in_transit'],
      ['2025-09-11T00:34:02+06:00', 'Picked', 'picked', 'accepted'],
      ['2025-09-10T19:42:51+06:00', 'New order pickup requested', '1', 'registered'],
    ]);
    const text = JSON.stringify(result);
    for (const privateValue of ['8801974081997', '01974081997', 'BILLAL', 'সুবর্ণা', 'Online Store', 'Mohammadpur']) expect(text).not.toContain(privateValue);
  });

  it('reads the estimate of a parcel on its way and keeps pending steps out', () => {
    const p = fixture();
    p.data.order.current_status = 'In Transit'; p.data.order.current_status_id = 4; p.data.order.estimated_date = 'Sep 13-14, 2025';
    p.data.logs = p.data.logs.slice(0, 2);
    for (const state of p.data.states.slice(3)) { state.status = 0; state.happened_at = ''; state.happened_at_utc = ''; }
    const result = parseCarryBee(p, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Transit',
      expected_delivery: '2025-09-14', expected_delivery_from: '2025-09-13' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map(event => event.description)).toEqual(['In Transit', 'Order has been reached at delivery hub', 'Picked', 'New order pickup requested']);
    p.data.order.estimated_date = 'Sep 9-10, 2025';
    expect(parseCarryBee(p, NUMBER).expected_delivery).toBeNull();
  });

  it('reads only the service\'s own absence as not found and keeps other refusals apart', () => {
    expect(() => parseCarryBee(load('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCarryBee({ error: true, message: 'internal error' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const payload of [null, {}, { error: 'false', data: {} }, { error: false, data: { order: null } }]) {
      expect(() => parseCarryBee(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = fixture(); empty.data.logs = []; for (const state of empty.data.states) state.status = 0;
    expect(() => parseCarryBee(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects another consignment and malformed rows', () => {
    type Payload = ReturnType<typeof fixture>;
    for (const mutate of [
      (p: Payload) => { p.data.order.consignment_id = 'F0910B74W5Z'; },
      (p: Payload) => { p.data.order.consignment_id = NUMBER + '1'; },
      (p: Payload) => { delete p.data.order.consignment_id; },
      (p: Payload) => { p.data.states = {}; },
      (p: Payload) => { p.data.logs = {}; },
      (p: Payload) => { p.data.logs[0].date_time_tz = '2025-09-10 19:42:51'; },
      (p: Payload) => { p.data.logs[0].transfer_status_id = '1'; },
      (p: Payload) => { p.data.logs[0].title = '<html>Denied</html>'; },
      (p: Payload) => { p.data.states[1].happened_at_utc = 'soon'; },
      (p: Payload) => { p.data.states[1].status = 2; },
      (p: Payload) => { p.data.states[1].slug = 'Picked Up'; },
    ]) {
      const p = fixture(); mutate(p);
      expect(() => parseCarryBee(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('leaves a new wording or step unmapped, and records the exchange step as a gap', () => {
    const p = fixture();
    p.data.order.current_status = 'Hold'; p.data.order.current_status_id = 30;
    p.data.logs.push({ title: 'Order is on hold', date_time: '', date_time_tz: '2025-09-12T09:00:00+06:00', transfer_status_id: 30 });
    const result = parseCarryBee(p, NUMBER);
    expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('current_stage');
    expect(result.events![0]).toMatchObject({ description: 'Order is on hold', provider_code: '30' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(statusMap.stage('exchange', 'exchange')).toBeUndefined();
    expect(statusMap.gaps).toEqual([expect.objectContaining({ code: 'exchange' })]);
    expect(statusMap.stage('lost', 'lost')).toBe('exception');
  });

  it('uses the supplied transport and the page\'s GET without a session', async () => {
    const fetcher = vi.fn(async (url, init) => {
      expect(String(url)).toBe(`https://api-merchant.carrybee.com/api/v2/track-order?consignment_id=${NUMBER}`);
      expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('cookie')).toBeNull();
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return Response.json(fixture());
    });
    const result = await instance(fetcher).track({ number: NUMBER.toLowerCase() }, { budgetMs: 1000 });
    expect(result.events).toHaveLength(7); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads the 404 with its not-found reply as absence, and no other 404', async () => {
    const found = vi.fn(async () => Response.json(load('not-found'), { status: 404 }));
    await expect(instance(found).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    const other = vi.fn(async () => Response.json({ message: 'no Route matched with those values' }, { status: 404 }));
    await expect(instance(other).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 302, 503])('never retries an HTTP %s or turns it into absence', async status => {
    const fetcher = vi.fn(async () => new Response('refused', { status }));
    await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: status === 403 ? 'challenge' : status === 429 ? 'rate_limited' : status === 503 ? 'maintenance' : 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps HTML challenges and malformed JSON distinct from absence', async () => {
    for (const [body, kind] of [['<title>Just a moment</title>', 'challenge'], ['<html>maintenance</html>', 'schema']]) {
      const fetcher = vi.fn(async () => new Response(body));
      await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('retries only a network failure and honors cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(Response.json(fixture()));
    expect((await instance(fetcher).track({ number: NUMBER })).events).toHaveLength(7);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const controller = new AbortController(); controller.abort(); fetcher.mockClear();
    await expect(instance(fetcher).track({ number: NUMBER }, { signal: controller.signal })).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses fragments and lists without a request', async () => {
    expect(normalizeCarryBeeNumber(' f0910 b74w5y ')).toBe(NUMBER);
    for (const value of ['F09', NUMBER + ',F0910B74W5Z', 'F0910-B74W5Y/']) {
      const fetcher = vi.fn<typeof fetch>();
      await expect(instance(fetcher).track({ number: value })).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(instance(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });
});
