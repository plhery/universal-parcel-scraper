import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff, hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeProfitFieldsNumber, parseProfitFields } from './parser.js';
import { profitFieldsStage } from './status.js';

const NUMBER = 'EWSXY974682510368YQ', PARTNER = 'SPXABC974682510368142731';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
const absent = () => ({ code: 200, data: { items: [{ queryNumber: NUMBER, found: false, status: 'notfound', id: NUMBER,
  carrier: '', timeline: [] as unknown[], flowLayout: [] }] } });

describe('Profit Fields guest history', () => {
  it('binds three identities, keeps the whole transfer reference and preserves each stated offset', () => {
    const result = parseProfitFields(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'SIGNED',
      last_update: '2026-07-04T09:51:00-04:00', destination_country: 'US', delivery_tracking_number: PARTNER, expected_delivery: null });
    expect(result.events).toHaveLength(5);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'registered']);
    expect(result.events![2]!.time).toBe('2026-07-02T01:28:00+08:00');
    expect(result).not.toHaveProperty('delivery_carrier'); expect(result).not.toHaveProperty('service_name');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(deliveryHandoff('profit-fields', NUMBER, result)).toEqual({ carrier: 'speedx', number: PARTNER, basis: 'reference' });
  });

  it('accepts only an exact bound absence and separates envelope failures', () => {
    expect(() => parseProfitFields(absent(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const [code, kind] of [[429, 'rate_limited'], [403, 'challenge'], [503, 'indeterminate']] as const) {
      expect(() => parseProfitFields({ ...absent(), code }, NUMBER)).toThrow(expect.objectContaining({ kind }));
    }
    const wrong = absent(); wrong.data.items[0]!.queryNumber += '1';
    expect(() => parseProfitFields(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const mixed = absent(); mixed.data.items[0]!.timeline.push(fixture().data.items[0].timeline[0]);
    expect(() => parseProfitFields(mixed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseProfitFields({ code: 200, data: { items: [] } }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a mismatched record, ambiguous batch, contradictory state and malformed clock', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.data.items[0].trackingNumber += '1'; },
      (p: ReturnType<typeof fixture>) => { p.data.items[0].id += '1'; },
      (p: ReturnType<typeof fixture>) => { p.data.items.push(p.data.items[0]); },
      (p: ReturnType<typeof fixture>) => { p.data.items[0].nodeStatus = 'IN_TRANSIT'; },
      (p: ReturnType<typeof fixture>) => { p.data.items[0].timeline[0].time = '2026-02-30 10:00:00'; },
      (p: ReturnType<typeof fixture>) => { p.data.items[0].timeline[0].timeZone = '(UTC +25:00)'; },
      (p: ReturnType<typeof fixture>) => { p.data.items[0].transferNumber = 'PRIVATE_REFERENCE'; },
    ]) {
      const data = fixture(); mutate(data);
      expect(() => parseProfitFields(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = fixture(); empty.data.items[0].timeline = [];
    expect(() => parseProfitFields(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps unspecified clocks local, unfamiliar states unresolved and contact suffixes private', () => {
    const data = fixture(), row = data.data.items[0];
    row.nodeStatus = row.timeline[0].nodeStatus = 'NEW_PHASE';
    row.timeline[0].timeZone = 'Unspecified'; row.timeline[0].eventEn = 'Processing update. Recipient: PRIVATE';
    row.timeline[0].location = 'PRIVATE Street 77';
    const result = parseProfitFields(data, NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.events![0]).toMatchObject({ local_time: '2026-07-04T09:51:00', provider_code: 'NEW_PHASE', description: 'Processing update.' });
    expect(result.events![0]).not.toHaveProperty('time'); expect(result.events![0]).not.toHaveProperty('stage');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    for (const location of ['地址：PRIVATE', 'PRIVATE Road 77']) {
      row.timeline[0].location = location;
      expect(parseProfitFields(data, NUMBER).events![0]).not.toHaveProperty('location');
    }
  });

  it('does not confuse local-carrier intake with out-for-delivery or final delivery', () => {
    for (const code of ['STARTED_DELIVERY', 'DELIVERED_TO_CARRIER', 'CLEARED', 'ARRIVED_PORT', 'DELIVERED_TO_PORT']) {
      expect(profitFieldsStage(code, 'Processing at Designated Facility')).toBe('in_transit');
    }
    expect(profitFieldsStage('LAST_MILE_DELIVERY', 'Delivery processing')).toBe('in_transit');
    expect(profitFieldsStage('NEW_PHASE', 'Delivered')).toBeUndefined();
    expect(profitFieldsStage(null, 'Shipping Label Created')).toBe('registered');
  });

  it('validates scans beyond the projection cap and never fabricates timeline rows from the diagram', () => {
    const data = fixture(), row = data.data.items[0];
    row.timeline = Array.from({ length: 101 }, (_, i) => ({ ...row.timeline[0], time: `2026-07-${String(28 - Math.floor(i / 4)).padStart(2, '0')} 10:${String(i % 4).padStart(2, '0')}:00` }));
    const result = parseProfitFields(data, NUMBER);
    expect(result.events).toHaveLength(100); expect(result.history_truncated).toBe(true);
    row.timeline[100].time = 'invalid';
    expect(() => parseProfitFields(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('offers supported EWS references to HTTP recognition while keeping partner issuer detection', async () => {
    expect(normalizeProfitFieldsNumber(' ewsxy 974682510368 yq ')).toBe(NUMBER);
    for (const reference of [NUMBER, 'EWSXY9746825103YQ']) {
      expect(detectCarrierMatch(reference).candidates).toContain('profit-fields');
      expect(recognitionAskedCarriers(reference)).toContain('profit-fields');
      expect(hasDirectHandoffAdapter('profit-fields', reference)).toBe(true);
    }
    expect(detectCarrierMatch(PARTNER).carrier).toBe('speedx');
    expect(hasDirectHandoffAdapter('profit-fields', PARTNER)).toBe(false);
    const fetcher = vi.fn(async () => Response.json(fixture()));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-07-04T13:51:00.000Z' });
    await expect(instance.recognize!(PARTNER)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => Response.json(absent()));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
  });
});
