import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { SparkTracker } from './adapter.js';
import { normalizeSparkNumber, parseSpark, sparkEndpoint, sparkReply } from './parser.js';
import { sparkStage, statusMap } from './status.js';

const NUMBER = 'SP00324369';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name = 'delivered.json') => JSON.parse(text(name));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const statuses = JSON.parse(text('../statuses.json')) as { entries: { code: string; wording: string; stage: string }[] };

describe('Spark tracker', () => {
  it('asks the invoice lookup with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new SparkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(' sp 0032-4369 ', { budgetMs: 4000 });
    expect(result.events).toHaveLength(7);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://gateway.spark.kz/order/api/v1/track-invoice/SP00324369?lang=en');
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Origin: 'https://spark.kz', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'spark-kz', step: 'direct', outcome: 'ok' }));
  });

  it('reads the done steps newest first, each dated to the day', () => {
    const result = parseSpark(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2024-11-11', expected_delivery: null });
    expect(result.events!.map(event => [event.local_time, event.description, event.provider_code, event.stage])).toEqual([
      ['2024-11-11', 'Delivered', '211', 'delivered'],
      ['2024-11-11', 'Courier is delivering', '210', 'out_for_delivery'],
      ['2024-11-11', 'Arrived at destination city', '208', 'in_transit'],
      ['2024-11-09', 'Cargo in transit', '206', 'in_transit'],
      ['2024-11-07', 'Processed and waiting for dispatch', '205', 'in_transit'],
      ['2024-11-07', 'Package picked up from sender', '203', 'accepted'],
      ['2024-11-07', 'Order created', '201', 'registered'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.location === undefined)).toBe(true);
  });

  it('keeps planned steps out of the history and gives the predicted day while the parcel travels', () => {
    const travelling = changed(d => {
      for (const step of d.data.statusHistory.slice(4)) Object.assign(step, { state: 'waiting', date: null });
    });
    const result = parseSpark(travelling, NUMBER);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Cargo in transit', last_update_local: '2024-11-09', expected_delivery: '2024-11-13' });
    expect(result.events).toHaveLength(4);
  });

  it('reads a cancelled pickup, skipping a done step without its day', () => {
    const result = parseSpark(fixture('cancelled.json'), 'SP00078479');
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Pickup cancelled', last_update_local: '2022-07-16', expected_delivery: null });
    expect(result.events!.map(event => event.provider_code)).toEqual(['204']);
  });

  it('classifies a code it does not map by the shared rules for its wording', () => {
    const result = parseSpark(changed(d => { Object.assign(d.data.statusHistory[6], { statusCode: 299, statusName: 'Returned to sender' }); }), NUMBER);
    expect(result.current_stage).toBe('returned');
    expect(result.current_stage_source).toMatch(/^wording:/);
    expect(sparkStage('211', 'Доставлено')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(sparkStage('299', 'Something new')).toBeNull();
  });

  it('reads the not-found reply as not found', async () => {
    expect(() => sparkReply(404, text('unknown.json'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('unknown.json'), 404, { 'Content-Type': 'application/json' }));
    await expect(new SparkTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps other failures apart from a missing parcel', async () => {
    expect(() => sparkReply(404, '{"message":"Not Found"}')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => sparkReply(404, '<html>Not Found</html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => sparkReply(200, '<html><title>Just a moment...</title></html>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSpark({ success: false, data: null }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const status of [403, 429, 500, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('refused', status));
      await expect(new SparkTracker({ fetcher }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
    }
    const moved = vi.fn<typeof fetch>().mockResolvedValue(response('', 302, { Location: '/' }));
    await expect(new SparkTracker({ fetcher: moved }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
  });

  it('reads an invoice with no dated step as listed without history', () => {
    const listed = changed(d => { for (const step of d.data.statusHistory) Object.assign(step, { state: 'waiting', date: null }); });
    expect(() => parseSpark(listed, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('rejects an answer for another number or with unreadable steps', () => {
    expect(() => parseSpark(changed(d => { d.data.invoiceNumber = 'SP00000001'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSpark(changed(d => { d.data.statusHistory[0].date = '2024-11-07'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSpark(changed(d => { d.data.statusHistory[0].date = '31.02.2024'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSpark(changed(d => { d.data.statusHistory[0].state = 'skipped'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSpark(changed(d => { d.data.statusHistory[0].statusCode = '201'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSpark(changed(d => { d.data.predictedDate = 'soon'; d.data.statusHistory[6].state = 'waiting'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects malformed input before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SparkTracker({ fetcher }).fetch('SP/1')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(() => normalizeSparkNumber('../x')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(sparkEndpoint('SP00324369')).toContain('/track-invoice/SP00324369?');
  });

  it('maps every code in statuses.json', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
      expect(sparkStage(entry.code, entry.wording)?.stage).toBe(entry.stage);
    }
  });
});
