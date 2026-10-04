import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SpxPhTracker } from './adapter.js';
import { parseSpxPh } from './parser.js';
const NUMBER = 'PH000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
function legacy() {
  const modern = fixture();
  return { retcode: 0, data: { sls_tracking_number: NUMBER, tracking_list: modern.data.sls_tracking_info.records.map((row: { description: string; actual_time: number }) => ({ message: row.description, timestamp: row.actual_time })) } };
}
describe('SPX Philippines parser', () => {
  it.each([false, true])('preserves identity-bound actual scans from legacy=%s', old => {
    const result = parseSpxPh(old ? legacy() : fixture(), NUMBER, old);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-03T16:00:00Z' });
    expect(result.events).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
  });
  it('binds verified modern order aliases without accepting a query echo', () => {
    const value = fixture(); value.data.order_info.sls_tn = NUMBER; value.data.order_info.spx_tn = 'SPXPH000000000001';
    expect(parseSpxPh(value, NUMBER).events).toHaveLength(2);
    delete value.data.order_info.sls_tn; value.data.requested = NUMBER;
    expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('excludes hidden modern records and keeps all-hidden history inconclusive', () => {
    const value = fixture(); value.data.sls_tracking_info.records[0].display_flag = 0;
    const result = parseSpxPh(value, NUMBER);
    expect(result.events).toHaveLength(1); expect(result.current_stage).toBe('out_for_delivery');
    value.data.sls_tracking_info.records[1].display_flag = 0;
    expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('ignores progress rails and requires actual history', () => {
    const value = fixture(); value.data.sls_tracking_info.records = [];
    expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('keeps empty and failed endpoint replies inconclusive', () => {
    for (const value of [{ retcode: 0, data: {} }, { retcode: 2, message: 'Unavailable' }]) {
      expect(() => parseSpxPh(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });
  it('rejects wrong identities, mixed rows and parent freight orders', () => {
    const wrong = fixture(); wrong.data.order_info.spx_tn = 'PH000000000002';
    expect(() => parseSpxPh(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const mixed = fixture(); mixed.data.sls_tracking_info.records[0].spx_tn = 'PH000000000002';
    expect(() => parseSpxPh(mixed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const parent = fixture(); parent.data.children = [{ spx_tn: NUMBER }];
    expect(() => parseSpxPh(parent, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('retains unknown wording and malformed clock uncertainty', () => {
    const value = fixture(); value.data.sls_tracking_info.records = [{ description: 'New operation', actual_time: 1767456000000 }];
    const result = parseSpxPh(value, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_update: null, events: [{ provider_time_text: '1767456000000' }] });
    expect(result.current_stage).toBeUndefined();
  });
});
describe('SPX Philippines retrieval', () => {
  it('uses the modern endpoint first and bounds legacy recovery to the same lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ retcode: 0, data: {} })))
      .mockResolvedValueOnce(new Response(JSON.stringify(legacy())));
    await new SpxPhTracker({ fetcher }).fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = new URL(String(fetcher.mock.calls[0]![0]));
    expect(first.pathname).toBe('/shipment/order/open/order/get_order_info'); expect(first.searchParams.get('spx_tn')).toBe(NUMBER);
    const second = new URL(String(fetcher.mock.calls[1]![0]));
    expect(second.pathname).toBe('/api/v2/fleet_order/tracking/search');
    expect(second.searchParams.get('sls_tracking_number')).toMatch(/^PH000000000001\|\d{10}[a-f0-9]{64}$/);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });
  it('does no I/O for foreign SPX numbers or an aborted lookup', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SpxPhTracker({ fetcher }).fetch('SPXMY000000000001')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new SpxPhTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
