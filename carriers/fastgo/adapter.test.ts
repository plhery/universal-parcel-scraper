import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FASTGO_ROUTES, fastgoRoutesBody } from './adapter.js';
import { normalizeFastgoNumber, parseFastgo } from './parser.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const archived = fixture('archived.json') as { result: Record<string, unknown>; code: string; msg: string };
// The several-waybill lookup answers the waybills it holds as a list of the same objects.
const listed = { result: [archived.result], code: '0000', msg: '成功' };
const number = 'AU111113587SG';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const withScans = (list: unknown[], extra: Record<string, unknown> = {}) => ({ code: '0000', result: [{ ...archived.result, ...extra, list }] });

describe('Fastgo waybills', () => {
  it('takes the waybill with spaces, hyphens or in lower case', () => {
    expect(normalizeFastgoNumber(' au 111113587-sg ')).toBe(number);
    expect(() => normalizeFastgoNumber('AU/111113587')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeFastgoNumber('AU1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('posts the waybill to the route lookup as the tracking page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(listed));
    const result = await tracker(fetcher).track({ number: 'au111113587sg' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(FASTGO_ROUTES);
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe('billIds%5B0%5D=AU111113587SG');
    expect(fastgoRoutesBody(number)).toBe(String(init?.body));
    expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '已完成清关，进入派送', last_update: null, last_update_local: '2019-12-24T18:21:24',
    });
  });

  it('reads the scans newest first on their wall clocks', () => {
    const { events = [] } = parseFastgo(archived, number);
    expect(events.map((event) => [event.local_time, event.stage])).toEqual([
      ['2019-12-24T18:21:24', 'in_transit'],
      ['2019-12-10T09:24:43', 'accepted'],
      ['2019-12-09T14:23:05', 'registered'],
    ]);
    expect(events[2]).toMatchObject({ description: '已经收到 包裹信息', stage_source: 'carrier_map' });
    expect(events.some((event) => event.time)).toBe(false);
  });

  it('keeps the last leg’s number, and names its courier only when the courier’s own rules take it', () => {
    // The public example's EMS number is not one China Post's rules offer.
    const result = parseFastgo(archived, number);
    expect(result.delivery_tracking_number).toBe('9975642011147');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('destination_country');
    // Synthetic: an SF Express waybill in its own layout.
    const sf = parseFastgo(withScans(archived.result.list as unknown[], { expressalias: '顺丰速运', expressno: 'SF3108264759013' }), number);
    expect(sf).toMatchObject({ delivery_carrier: 'sf-express', delivery_tracking_number: 'SF3108264759013', destination_country: 'CN' });
    const none = parseFastgo(withScans(archived.result.list as unknown[], { expressalias: null, expressno: null }), number);
    expect(none).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads a scan the map does not know by the shared wording rules, or leaves it without a stage', () => {
    // Synthetic scans after the public example's last one.
    const result = parseFastgo(withScans([...(archived.result.list as unknown[]),
      { time: '2019-12-26 10:00:00', remark: 'Synthetic note', flag: '1' }]), number);
    expect(result.events?.[0]).toMatchObject({ description: 'Synthetic note', local_time: '2019-12-26T10:00:00' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result.current_stage).toBe('in_transit');
  });

  it('reports a waybill the route lookup leaves out as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture('not-found.json')));
    await expect(tracker(fetcher).track({ number })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('requires the waybill asked before reading a history', () => {
    expect(() => parseFastgo(listed, 'AU111113588SG')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take a failure, a changed reply or a verification page for a missing waybill', async () => {
    expect(() => parseFastgo({ code: '9999', msg: '未知错误' }, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFastgo({ code: '0000', result: 'none' }, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastgo(withScans([{ time: '2019-12-09', remark: 'x' }]), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastgo(withScans([{ time: '2019-02-30 10:00:00', remark: 'x' }]), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastgo(withScans([]), number)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><head><title>Just a moment...</title></head></html>'));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(tracker(moved).track({ number })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('recognizes a waybill the lookup holds, and not one it leaves out', async () => {
    const held = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(listed));
    await expect(tracker(held).recognize!(number)).resolves.toMatchObject({ known: true });
    const missing = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture('not-found.json')));
    await expect(tracker(missing).recognize!(number)).resolves.toMatchObject({ known: false });
  });
});
