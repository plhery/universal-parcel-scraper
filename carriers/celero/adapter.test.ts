import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CeleroTracker } from './adapter.js';
import { CELERO_ENDPOINT, celeroJson, normalizeCeleroNumber, parseCelero } from './parser.js';
import { celeroStage, statusMap } from './status.js';

const NUMBER = 'MU120109191821';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/shipment.json', import.meta.url), 'utf8'));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const rows = (data: ReturnType<typeof fixture>) => data.data[NUMBER];
const response = (data: unknown, status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { wording: string; stage: string }[] };

describe('Celero guest adapter', () => {
  it('posts the number as the tracking form does, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new CeleroTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(CELERO_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', Origin: 'https://celerogroup.com', 'User-Agent': 'SyntheticHost/1' } });
    expect(JSON.parse(init!.body as string)).toEqual({ awbs: [NUMBER] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'celero', step: 'direct', outcome: 'ok' }));
  });

  it('reads the scans newest first on their wall clocks, a midnight clock as its day alone', () => {
    const result = parseCelero(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'CUSTOMS CLEARED', last_update: null, last_update_local: '2026-04-11', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2026-04-11', description: 'CUSTOMS CLEARED', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-04-06T13:53:00', description: 'MANIFEST RECEIVED', stage: 'registered', stage_source: 'carrier_map' },
      { local_time: '2026-04-06T10:00:00', description: 'MANIFEST RECEIVED', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.some(event => 'time' in event)).toBe(false);
  });

  it('orders scans by the record numbers Celero wrote them under', () => {
    const result = parseCelero(changed(d => { d.data[NUMBER] = [...rows(d)].reverse(); }), NUMBER);
    expect(result.events!.map(event => event.local_time)).toEqual(['2026-04-11', '2026-04-06T13:53:00', '2026-04-06T10:00:00']);
  });

  it('adds a fault or remark in words, and leaves out bare references', () => {
    const result = parseCelero(changed(d => {
      Object.assign(rows(d)[0], { awb_status: 'ON HOLD', awb_fault: 'Awaiting payment of duties', awb_remarks: 'SD3C000000000' });
    }), NUMBER);
    expect(result.events![0]).toMatchObject({ description: 'ON HOLD: Awaiting payment of duties' });
    expect(result).toMatchObject({ last_status_text: 'ON HOLD: Awaiting payment of duties' });
  });

  it('reads a status its map does not record through the shared rules, and keeps the stage of the newest it reads', () => {
    expect(celeroStage('DELIVERED')).toEqual({ stage: 'delivered', source: expect.stringMatching(/^wording:/) });
    expect(celeroStage('XQZW')).toBeNull();
    const result = parseCelero(changed(d => { rows(d)[0].awb_status = 'XQZW'; }), NUMBER);
    expect(result).toMatchObject({ current_stage: 'registered', last_status_text: 'XQZW' });
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('reports a number Celero does not know as not found, and nothing else', () => {
    expect(() => parseCelero({ success: true, count: 1, data: { [NUMBER]: [] }, errors: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCelero({ success: true, count: 1, data: { MU999999999999: [] }, errors: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCelero({ success: false, error: 'No valid AWBs provided', errors: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCelero(changed(d => { d.errors = { [NUMBER]: 'lookup failed' }; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds every scan to the whole number', () => {
    expect(() => parseCelero(changed(d => { rows(d)[1].awb_num = 'MU120109191822'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects changed replies and verification pages rather than calling them missing', async () => {
    for (const edit of [
      (d: ReturnType<typeof fixture>) => { rows(d)[0].awb_date = '11/04/2026'; },
      (d: ReturnType<typeof fixture>) => { rows(d)[0].awb_date = '2026-02-30 10:00:00'; },
      (d: ReturnType<typeof fixture>) => { rows(d)[0].awb_status = ''; },
      (d: ReturnType<typeof fixture>) => { rows(d)[0].awb_status = 5; },
      (d: ReturnType<typeof fixture>) => { delete rows(d)[0].ID; },
      (d: ReturnType<typeof fixture>) => { rows(d)[1].ID = rows(d)[0].ID; },
      (d: ReturnType<typeof fixture>) => { d.data[NUMBER] = {}; },
      (d: ReturnType<typeof fixture>) => { d.data = []; },
    ]) expect(() => parseCelero(changed(edit), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => celeroJson('<html><title>Just a moment...</title></html>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => celeroJson('<html><body>maintenance</body></html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const limited = vi.fn<typeof fetch>().mockResolvedValue(response('slow down', 429));
    await expect(new CeleroTracker({ fetcher: limited }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
    for (const status of [404, 410]) {
      await expect(new CeleroTracker({ fetcher: async () => new Response(null, { status }) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    }
    expect(() => normalizeCeleroNumber('MU-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('maps every recorded status as its statuses say', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
  });

  it('serves its id through the registry contract', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const carrier = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(carrier).toMatchObject({ id: 'celero', steps: ['direct'], recordsSteps: true });
    await expect(carrier.track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'in_transit' });
  });
});
