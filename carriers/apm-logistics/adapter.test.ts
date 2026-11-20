import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, ApmLogisticsTracker, apmLogisticsPageUrl, apmLogisticsTraceUrl, normalizeApmLogisticsNumber, parseApmLogistics } from './adapter.js';
import { apmLogisticsStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import sample from './fixtures/awb-3000266983.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };

type Reply = typeof sample;
const NUMBER = sample.shipment.awb;
const TRACE = apmLogisticsTraceUrl();
const copy = (): Reply => structuredClone(sample);
const capture = (data: unknown = sample, extra: Record<string, unknown> = {}) => ({ url: TRACE, status: 200, trackingNumberSubmitted: NUMBER,
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'apm-logistics-reply', url = apmLogisticsPageUrl(NUMBER)) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url, html: '', statusCode: 200,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new ApmLogisticsTracker(environment) };
}

describe('APM Logistics tracker', () => {
  it('reads the example waybill: received at Medan, then handed on to a partner', () => {
    const result = parseApmLogistics(sample, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'PAKET DITERUSKAN KE KOTA TUJUAN', last_update: null, last_update_local: '2025-01-13T17:10:25', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2025-01-13T17:10:25', description: 'PAKET DITERUSKAN KE KOTA TUJUAN', location: 'KAB. DELI SERDANG',
        provider_code: 'PAKET DITERIMA VENDOR', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2025-01-13T17:09:26', description: 'PAKET DITERIMA CABANG', location: 'KAB. DELI SERDANG',
        provider_code: 'PAKET DITERIMA CABANG', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
  });

  it('adds the delivery the reply reports, at the destination', () => {
    // Invented: the example delivered the next morning.
    const delivered = copy();
    delivered.delivery = { status: 'TERKIRIM', date: '2025-01-16', time: '09:30' };
    expect(parseApmLogistics(delivered, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'TERKIRIM',
      last_update_local: '2025-01-16T09:30:00' });
    expect(parseApmLogistics(delivered, NUMBER).events![0]).toEqual({ local_time: '2025-01-16T09:30:00', description: 'TERKIRIM',
      location: 'KOTA JAKARTA TIMUR', provider_code: 'TERKIRIM', stage: 'delivered', stage_source: 'carrier_map' });
    delivered.delivery = { status: 'DELIVERED', date: '2025-01-16 09:30:15', time: '-' };
    expect(parseApmLogistics(delivered, NUMBER).events![0]).toMatchObject({ local_time: '2025-01-16T09:30:15', stage: 'delivered' });
    delivered.delivery = { status: 'TERKIRIM', date: '2025-01-16', time: '-' };
    expect(parseApmLogistics(delivered, NUMBER).events![0]).toMatchObject({ local_time: '2025-01-16', stage: 'delivered' });
    delivered.delivery = { status: 'TERKIRIM', date: '-', time: '-' };
    expect(() => parseApmLogistics(delivered, NUMBER)).toThrow(SchemaError);
  });

  it('keeps a checkpoint it cannot stage, once, in the order the tracker gives', () => {
    // Invented: a later checkpoint in words the map does not know, and the handover repeated.
    const reply = copy();
    const [received, forwarded] = reply.checkpoint;
    reply.checkpoint = [received!, forwarded!, { ...forwarded!, code_checkpoint: 'PAKET TIBA DI HUB', datetime: '2025-01-13 17:10:25' }, forwarded!];
    const result = parseApmLogistics(reply, NUMBER);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['PAKET TIBA DI HUB', 'PAKET DITERIMA VENDOR', 'PAKET DITERIMA CABANG']);
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'PAKET TIBA DI HUB' });
  });

  it('answers only for the waybill asked', () => {
    expect(() => parseApmLogistics(unknown, NUMBER)).toThrow(NotFoundError);
    expect(() => parseApmLogistics({ success: false, messages: 'Synthetic refusal' }, NUMBER)).toThrow(IndeterminateError);
    expect(() => parseApmLogistics(sample, '0000000001')).toThrow(IndeterminateError);
    const other = copy(); other.checkpoint[0]!.awb_number = '0000000001';
    expect(() => parseApmLogistics(other, NUMBER)).toThrow(IndeterminateError);
  });

  it('refuses a reply it cannot read', () => {
    const broken = (edit: (reply: Record<string, unknown>) => void) => { const reply = copy() as unknown as Record<string, unknown>; edit(reply); return reply; };
    expect(() => parseApmLogistics(null, NUMBER)).toThrow(SchemaError);
    expect(() => parseApmLogistics({ messages: 'Shipment ditemukan' }, NUMBER)).toThrow(SchemaError);
    expect(() => parseApmLogistics(broken((reply) => { delete reply.shipment; }), NUMBER)).toThrow(SchemaError);
    expect(() => parseApmLogistics(broken((reply) => { reply.checkpoint = null; }), NUMBER)).toThrow(SchemaError);
    expect(() => parseApmLogistics(broken((reply) => { reply.delivery = 'TERKIRIM'; }), NUMBER)).toThrow(SchemaError);
    for (const edit of [{ datetime: '13/01/2025 17:09' }, { datetime: '1999-01-13 17:09:26' }, { code_checkpoint: ' ' }]) {
      const reply = copy(); reply.checkpoint = [{ ...reply.checkpoint[0]!, ...edit }];
      expect(() => parseApmLogistics(reply, NUMBER), JSON.stringify(edit)).toThrow(SchemaError);
    }
    expect(() => parseApmLogistics({ ...copy(), checkpoint: [] }, NUMBER)).toThrow(NoHistoryError);
  });

  it('takes a ten-digit waybill and refuses anything else before asking', async () => {
    expect(normalizeApmLogisticsNumber(' 30002 66983 ')).toBe(NUMBER);
    const h = harness();
    for (const number of ['300026698', '30002669831', '3000-266983', 'APM3000266983', '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('apm-logistics');
  });

  it('asks the browser service for the tracker page and its bound lookup', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: 'https://apmlogistics.id/cek-resi?resi=3000266983', skipHttp: true, maxTier: 3, captureResponses: [TRACE] });
    expect(adapter(h.environment)).toMatchObject({ id: 'apm-logistics', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads an unknown waybill as not found, a refused token as a challenge, and other answers as what they are', async () => {
    await expect(harness([capture(unknown)]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture(null, { body: '', error: 'recaptcha-refused' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { body: '', error: 'recaptcha-refused' }), capture()]).tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'in_transit' });
    await expect(harness([capture(null, { body: '', error: 'challenge-html' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 403, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 429, body: '', headers: { 'retry-after': '60' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture(null, { status: 502, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 502 });
    await expect(harness([capture(sample, { trackingNumberSubmitted: '0000000001' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(), capture(), capture()]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(sample, { truncated: true })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { body: '<html>', error: 'invalid-json' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture()], 'apm-logistics-reply', 'https://apmlogistics.id/').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 'apm-logistics-capture_missing').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'apm-logistics-runtime').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new ApmLogisticsTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps every status it has seen or the tracker names', () => {
    for (const entry of statuses.entries) {
      expect(apmLogisticsStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'apm-logistics', providerCode: entry.code, description: entry.wording }), entry.code)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
  });
});
