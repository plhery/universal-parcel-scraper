import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { carrierHomeZone, dateLocalClocks } from '../../places/clocks.js';
import { normalizeZnlogicNumber, parseZnlogic } from './parser.js';
import { znlogicStage } from './status.js';

const NUMBER = 'ZPYXY9746825104YQ';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
const absent = () => ({ error: { code: 'not_found', message: `Shipment with ID '${NUMBER}' not found`, details: { resource: 'Shipment', id: NUMBER } } });

describe('Zinc guest history', () => {
  it('retains offsetless scans and countries without ZIP, retailer or delivering-carrier credentials', () => {
    const result = parseZnlogic(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', origin_country: 'US', destination_country: 'US', last_update: null,
      last_update_local: '2026-01-06T12:43:00', expected_delivery: null });
    expect(result.events).toHaveLength(6);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'in_transit']);
    expect(result.events!.every(event => !event.time && event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|00000|zip_code|human_time/);
    expect(result).not.toHaveProperty('delivery_carrier'); expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(deliveryHandoff('znlogic', NUMBER, result)).toBeNull();
  });

  it('keeps the wall clock beside a marked consumer inference instead of the headquarters clock', () => {
    expect(carrierHomeZone('znlogic')).toBe('America/New_York');
    const p = fixture(); p.history = [{ ...p.history[0], location: null }];
    const result = dateLocalClocks('znlogic', parseZnlogic(p, NUMBER));
    expect(result.events![0]).toMatchObject({ local_time: '2026-01-06T12:43:00' });
    expect(result.events![0]).toMatchObject({ time: '2026-01-06T12:43:00-05:00', time_zone: 'America/New_York', time_zone_basis: 'destination' });
    const placed = dateLocalClocks('znlogic', parseZnlogic(fixture(), NUMBER));
    expect(placed.events![0]).toMatchObject({ local_time: '2026-01-06T12:43:00', time: '2026-01-06T12:43:00-05:00', time_zone_basis: 'place' });
  });

  it('requires an exact shipment-bound 404 rather than a missing route or mixed response', () => {
    expect(() => parseZnlogic(absent(), NUMBER, 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const wrong = absent(); wrong.error.details.id += '1';
    expect(() => parseZnlogic(wrong, NUMBER, 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZnlogic({ ...absent(), history: [] }, NUMBER, 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZnlogic({ error: { code: 'route_missing' } }, NUMBER, 404)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseZnlogic(absent(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects malformed clocks, contradictory states and a supplied different positive identifier', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.tracking_id = NUMBER + '1'; },
      (p: ReturnType<typeof fixture>) => { p.history[0].time = '2026-02-30T12:43:00.000'; },
      (p: ReturnType<typeof fixture>) => { p.history[0].time += 'Z'; },
      (p: ReturnType<typeof fixture>) => { p.last_update_summary = 'Out for Delivery'; },
      (p: ReturnType<typeof fixture>) => { p.error = { code: 'pending' }; },
    ]) {
      const p = fixture(); mutate(p);
      expect(() => parseZnlogic(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('leaves new wording unstaged without promoting a partner handoff or an old delivery', () => {
    const p = fixture(); p.history[0].message = 'Processing update. Recipient: PRIVATE'; p.history[0].location = 'PRIVATE Road 77';
    const result = parseZnlogic(p, NUMBER);
    expect(result.status).toBe('unknown'); expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events![0]).not.toHaveProperty('location'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(znlogicStage(null, 'Delivered to shipping partner')).toBeUndefined();
    expect(znlogicStage(null, 'Delivered transfer information')).toBeUndefined();
    expect(znlogicStage(null, 'Picked Up By Shipping Partner, USPS Awaiting Item')).toBe('in_transit');
    expect(znlogicStage(null, 'USPS Awaiting Item')).toBe('registered');
  });

  it('validates rows beyond the projection and keeps all distinct logistics scans', () => {
    const p = fixture(), row = p.history[0];
    p.history = Array.from({ length: 101 }, (_, i) => ({ ...row, time: `2026-01-06T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000` }));
    expect(parseZnlogic(p, NUMBER).events).toHaveLength(100); expect(parseZnlogic(p, NUMBER).history_truncated).toBe(true);
    p.history[100].time = 'invalid';
    expect(() => parseZnlogic(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeZnlogicNumber(' zpyxy 9746825104 yq ')).toBe(NUMBER);
  });
});
