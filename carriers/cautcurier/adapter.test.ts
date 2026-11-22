import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { CautCurierTracker } from './adapter.js';
import { normalizeCautCurierNumber, parseCautCurier } from './parser.js';
import { statusMap } from './status.js';

const NUMBER = '489581';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const cancelled = () => JSON.parse(fixture('cancelled.json')) as { data: Record<string, unknown> } & Record<string, unknown>;
const response = (body: string, status = 200, type = 'application/json; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const NOT_FOUND = fixture('not-found.json');

describe('CautCurier order lookup adapter', () => {
  it('asks the lookup for one AWB, with no session or token, and keeps its instants', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('cancelled.json')));
    const result = await new CautCurierTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://tracking-api.cautcurier.ro/api/Tracker/GetOrderDetails?awb=${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Order Cancelled By Admin',
      last_update: '2026-04-16T15:52:09Z', weight_kg: 1 });
    expect(result.events!.map(event => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-04-16T15:52:09Z', 'CanceledByHQAdmin', 'Order Cancelled By Admin', 'exception'],
      ['2026-04-09T12:38:06Z', 'Created', 'Order Created', 'registered'],
    ]);
    expect(result.events!.every(event => !event.local_time && !event.location)).toBe(true);
    const text = JSON.stringify(result);
    for (const party of ['Xx***xx', 'Yy***YY']) expect(text).not.toContain(party);
  });

  it('reads only the exact HTTP 500 message as a missing order', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(NOT_FOUND, 500));
    await expect(new CautCurierTracker({ fetcher }).fetch('489599999')).rejects.toMatchObject({ kind: 'not_found' });
    for (const body of ['{"message":"An error has occurred."}', '{"message":"Object reference not set to an instance of an object.","trace":"x"}',
      '<html><body>Internal Server Error</body></html>', '']) {
      const failing = vi.fn<typeof fetch>().mockResolvedValue(response(body, 500));
      await expect(new CautCurierTracker({ fetcher: failing }).fetch(NUMBER), body).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    // The same message on HTTP 200 is no order either way, and not an absence.
    expect(() => parseCautCurier(JSON.parse(NOT_FOUND), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts only the order of the AWB asked, with valid events', () => {
    const other = cancelled();
    other.data.id = 489582;
    expect(() => parseCautCurier(other, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const failed = cancelled();
    failed.success = false;
    expect(() => parseCautCurier(failed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const item of [{ type: 'Created', timestamp: 'soon' }, { type: '', timestamp: 1775738286 }, { type: 'Created' }]) {
      const broken = cancelled();
      broken.data.eventItems = [item];
      expect(() => parseCautCurier(broken, NUMBER), JSON.stringify(item)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // An order with its type and no events yet is a summary.
    const fresh = cancelled();
    Object.assign(fresh.data, { orderStatus: 'Allocated', eventItems: [] });
    expect(parseCautCurier(fresh, NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered', provider_code: 'Allocated',
      last_status_text: 'Order Allocated', last_update: null, summary_only: true, events: [] });
    for (const number of ['123', '0489581', 'AWB489581', '1234567890123']) {
      expect(() => normalizeCautCurierNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('orders events newest first and maps each type', () => {
    const shuffled = cancelled();
    Object.assign(shuffled.data, { orderStatus: 'Delivery', eventItems: [
      { type: 'Created', timestamp: 1775738286 }, { type: 'Picked', timestamp: 1775740000 }, { type: 'InWarehouse', timestamp: 1775750000 },
      { type: 'NotHome', timestamp: 1775760000 }, { type: 'Delivery', timestamp: 1775770000 }, { type: 'Mystery', timestamp: 1775770000 },
    ] });
    const result = parseCautCurier(shuffled, NUMBER);
    expect(result.events!.map(event => [event.provider_code, event.stage])).toEqual([
      ['Mystery', undefined], ['Delivery', 'delivered'], ['NotHome', 'failed_attempt'], ['InWarehouse', 'in_transit'], ['Picked', 'accepted'], ['Created', 'registered'],
    ]);
    // The order's own type gives the current status even when an unmapped event shares its second.
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Order Delivered' });
    expect(statusMap.stage('ReturnPickedUp', 'return picked up')).toBe('returned');
    expect(statusMap.stage('CanceledBySender', 'order cancelled by sender')).toBe('exception');
    expect(statusMap.stage('Mystery', 'mystery')).toBeUndefined();
  });

  it('keeps checks and transport failures distinct from a missing order', async () => {
    const page = '<html><head><title>Just a moment...</title></head><body></body></html>';
    for (const [body, status, kind] of [[page, 403, 'challenge'], [page, 200, 'challenge'], ['', 302, 'transport'], ['', 404, 'transport'],
      ['', 429, 'rate_limited'], ['', 503, 'maintenance'], ['not json', 200, 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body, status, 'text/html'));
      await expect(new CautCurierTracker({ fetcher }).fetch(NUMBER), `${status} ${body}`).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('reads the tracking page links and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('cautcurier');
    expect(parseTrackingInput(`https://tracking.cautcurier.ro/?awb=${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'cautcurier' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('cancelled.json')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'cautcurier', number: NUMBER });
    expect(tracked.source).toBe('cautcurier');
    expect(tracked.result.current_stage).toBe('exception');
  });
});
