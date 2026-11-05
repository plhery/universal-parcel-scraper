import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeLmParcelNumber, parseLmParcel, parseLmParcelSummary } from './parser.js';
import { lmParcelStage } from './status.js';

const NUMBER = 'LM9746825104', PARTNER = 'SPXABC974682510368';
const fixture = () => ({
  summary: JSON.parse(readFileSync(new URL('./fixtures/summary.json', import.meta.url), 'utf8')),
  details: JSON.parse(readFileSync(new URL('./fixtures/details.json', import.meta.url), 'utf8')),
});
const absent = () => ({ code: '0', success: true, data: [{ searchNo: NUMBER, waybillNo: null, originTime: 0, occurTime: 0, status: 1,
  originCountry: null, targetCountry: null, routeType: null, routeContent: null, occurCountry: null, occurAddr: null }] });

describe('LM Parcel guest history', () => {
  it('decodes China-encoded wall digits with each stated offset and orders crossing instants', () => {
    const { summary, details } = fixture(), result = parseLmParcel(summary, details, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', provider_code: '1300',
      last_update: '2026-01-06T15:53:15-08:00', origin_country: 'CN', destination_country: 'US',
      delivery_tracking_number: PARTNER, expected_delivery: null });
    expect(result.events).toHaveLength(14);
    expect(result.events![1]).toMatchObject({ time: '2026-01-06T07:58:57-08:00', stage: 'out_for_delivery' });
    expect(result.events![2]).toMatchObject({ time: '2026-01-04T14:50:56-08:00', stage: 'in_transit' });
    const arrived = result.events!.findIndex(event => event.provider_code === '800');
    const departed = result.events!.findIndex(event => event.provider_code === '700');
    expect(arrived).toBeLessThan(departed);
    expect(result.events![arrived]!.time).toBe('2026-01-01T22:25:00-08:00');
    expect(result.events![departed]!.time).toBe('2026-01-02T03:00:00+08:00');
    expect(result.events!.map(event => Date.parse(event.time!))).toEqual(result.events!.map(event => Date.parse(event.time!)).sort((a, b) => b - a));
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|00000|operateBy|updatedTime/);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(deliveryHandoff('lm-parcel', NUMBER, result)).toEqual({ carrier: 'speedx', number: PARTNER, basis: 'reference' });
  });

  it('requires a whole query, whole waybill and every whole detail identity before accepting a reply', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.summary.data[0].searchNo += '1'; },
      (p: ReturnType<typeof fixture>) => { p.summary.data[0].waybillNo += '1'; },
      (p: ReturnType<typeof fixture>) => { p.summary.data.push(p.summary.data[0]); },
      (p: ReturnType<typeof fixture>) => { p.details.data[13].waybillNo += '1'; },
      (p: ReturnType<typeof fixture>) => { p.summary.data[0].occurTime += 1; },
      (p: ReturnType<typeof fixture>) => { p.summary.data[0].status = 2; },
      (p: ReturnType<typeof fixture>) => { p.details.success = false; },
      (p: ReturnType<typeof fixture>) => { p.details.error = { message: 'Lookup incomplete' }; },
      (p: ReturnType<typeof fixture>) => { p.details.data[0].occurTime = 0; },
      (p: ReturnType<typeof fixture>) => { p.details.data[0].timeZone = '+14:01'; },
    ]) {
      const p = fixture(); mutate(p);
      expect(() => parseLmParcel(p.summary, p.details, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const p = fixture(); p.details.data = [];
    expect(() => parseLmParcel(p.summary, p.details, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts only the bound empty search signature and keeps business failures distinct', () => {
    expect(() => parseLmParcelSummary(absent(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const mutation of [
      { searchNo: NUMBER + '1' }, { waybillNo: NUMBER }, { routeType: 100 }, { occurTime: 1 }, { routeContent: 'Item information received.' },
    ]) {
      const p = absent(); Object.assign(p.data[0]!, mutation);
      expect(() => parseLmParcelSummary(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const [code, kind] of [[429, 'rate_limited'], [403, 'challenge'], [500, 'indeterminate']] as const) {
      expect(() => parseLmParcelSummary({ ...absent(), code }, NUMBER)).toThrow(expect.objectContaining({ kind }));
    }
  });

  it('keeps missing offsets local and unknown current codes unresolved without borrowing an old delivery', () => {
    const p = fixture(); p.summary.data[0].routeType = p.details.data[0].routeType = 9999;
    p.details.data[0].timeZone = 'Unspecified'; p.details.data[0].routeContent = 'Processing update. Recipient: PRIVATE';
    p.details.data[0].occurAddr = 'PRIVATE Street 7';
    const result = parseLmParcel(p.summary, p.details, NUMBER);
    expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('current_stage');
    expect(result.events![0]).toMatchObject({ provider_code: '9999', local_time: '2026-01-06T15:53:15', description: 'Processing update.' });
    expect(result.events![0]).not.toHaveProperty('time'); expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events![0]).not.toHaveProperty('location'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(lmParcelStage('1215', 'Out for Delivery')).toBe('out_for_delivery');
    expect(lmParcelStage('1215', 'Processing at Designated Facility')).toBe('in_transit');
    expect(lmParcelStage('1150', 'Delivery to local courier')).toBe('in_transit');
    expect(lmParcelStage('9999', 'Delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'lm-parcel', providerCode: '430', description: 'Last mile tracking number assigned' })).toMatchObject({ kind: 'intentional_gap' });
  });

  it('retains administrative assignment without guessing between multiple partner references', () => {
    const p = fixture();
    p.details.data.push({ ...p.details.data[9], routeContent: 'Last mile, tracking number SPXABC974682510369' });
    const result = parseLmParcel(p.summary, p.details, NUMBER);
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events!.filter(event => event.provider_code === '430').every(event => event.stage === undefined)).toBe(true);
  });

  it('validates every source row beyond the bounded projection', () => {
    const p = fixture(), row = p.details.data[0];
    p.details.data = Array.from({ length: 101 }, (_, i) => ({ ...row, occurTime: row.occurTime - i * 60_000 }));
    expect(parseLmParcel(p.summary, p.details, NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseLmParcel(p.summary, p.details, NUMBER).events).toHaveLength(100);
    p.details.data[100].waybillNo += '1';
    expect(() => parseLmParcel(p.summary, p.details, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeLmParcelNumber(' lm 9746825104 ')).toBe(NUMBER);
  });
});
