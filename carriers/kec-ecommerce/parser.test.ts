import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveResult } from '../../core/result/resolve.js';
import { KEC_MAX_BYTES, normalizeKecNumber, parseKec } from './parser.js';
import { kecStage, statusMap } from './status.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const NUMBER = 'KECSYNTH39057186240';

describe('KEC eCommerce guest history parser', () => {
  it('does not state an older delivery through a newer unmapped scan', () => {
    const payload = fixture();
    payload.data[0].status.unshift({ ...payload.data[0].status[0], status_code: 'synthetic_amendment',
      track_message: 'Synthetic carrier amendment', event_date: '2026-04-22 10:00:00', timezone: 'UTC+00:00', timezone_date: '2026-04-22 10:00:00' });
    const result = parseKec(payload, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic carrier amendment', last_update: '2026-04-22T10:00:00+00:00' });
    expect(result).not.toHaveProperty('current_stage');
    expect(resolveResult(result).current_stage).not.toBe('delivered');
    expect(result.events?.[1]).toMatchObject({ stage: 'delivered' });
  });

  it('binds the whole number and retains local wall clocks with their explicit offsets', () => {
    const result = parseKec(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: '2026-04-21T09:13:16+00:00', expected_delivery: null });
    expect(result.events).toHaveLength(7);
    expect(result.events![4]).toMatchObject({ time: '2026-04-19T07:15:00+08:00', provider_code: 'air_freight_uplift',
      description: 'Flight departure', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![6]).toMatchObject({ stage: 'registered' });
    expect(result.events![6]).not.toHaveProperty('location');
    expect(result).not.toHaveProperty('history_truncated');
    expect(result).not.toHaveProperty('canonical_tracking_number');
  });

  it('sorts by instants across offsets and accepts a negative fractional offset', () => {
    const p = fixture(), rows = p.data[0].status;
    p.data[0].status = [
      { ...rows[4], event_date: '2026-04-21 23:10:00', timezone: 'UTC-03:30', timezone_date: '2026-04-22 02:40:00' },
      { ...rows[0], event_date: '2026-04-22 09:00:00', timezone: 'UTC+08:00', timezone_date: '2026-04-22 01:00:00' },
    ];
    const result = parseKec(p, NUMBER);
    expect(result.events!.map(event => event.time)).toEqual(['2026-04-21T23:10:00-03:30', '2026-04-22T09:00:00+08:00']);
    expect(result.last_update).toBe('2026-04-21T23:10:00-03:30');
  });

  it('retains the carrier order at one instant', () => {
    const p = fixture(), first = p.data[0].status[0];
    p.data[0].status = [{ ...first, track_message: 'Synthetic scan A' }, { ...first, track_message: 'Synthetic scan B' }];
    expect(parseKec(p, NUMBER).events!.map(event => event.description)).toEqual(['Synthetic scan A', 'Synthetic scan B']);
  });

  it.each(['KECSYNTH390571862407', 'OTHER39057186240'])('rejects a different whole identity (%s)', identity => {
    const p = fixture(); p.data[0].tracking_number = identity;
    expect(() => parseKec(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([{}, [], null, 39057186240])('rejects a malformed shipment identity', identity => {
    const p = fixture(); p.data[0].tracking_number = identity;
    expect(() => parseKec(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([
    { event_date: '2026-02-30 09:13:16' },
    { event_date: '2026-04-21 24:00:00' },
    { event_date: '2026-04-21' },
    { timezone: 'UTC+08:99' },
    { timezone: 'UTC+14:30' },
    { timezone: 'Asia/Hong_Kong' },
    { timezone: {} },
    { timezone_date: '2026-04-21 09:14:16' },
    { timezone_date: [] },
    { track_message: {} },
    { track_message: '' },
    { status_code: ['lastmile_delivered'] },
    { location: { name: 'Synthetic depot' } },
  ])('rejects invalid scan fields without inventing a clock or text', replacement => {
    const p = fixture(); Object.assign(p.data[0].status[0], replacement);
    expect(() => parseKec(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('allows a missing optional UTC copy while retaining the stated offset', () => {
    const p = fixture(); delete p.data[0].status[4].timezone_date;
    expect(parseKec(p, NUMBER).events![4]!.time).toBe('2026-04-19T07:15:00+08:00');
  });

  it.each([
    { responsecode: '200001', data: [] },
    { responsecode: '200001', data: [{ tracking_number: NUMBER, status: [] }] },
    { responsecode: '500001', data: [] },
  ])('keeps unsuccessful and empty replies inconclusive', payload => {
    expect(() => parseKec(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not read shipment rows when the success code is missing', () => {
    const p = fixture(); delete p.responsecode;
    expect(() => parseKec(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects mixed shipment results and excessive scan arrays', () => {
    const p = fixture(); p.data.push({ ...p.data[0], tracking_number: 'OTHER39057186240' });
    expect(() => parseKec(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    p.data.pop(); p.data[0].status = Array.from({ length: 501 }, () => p.data[0].status[0]);
    expect(() => parseKec(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('marks retained history partial when its scan limit is reached', () => {
    const p = fixture(), scan = p.data[0].status[0];
    p.data[0].status = Array.from({ length: 301 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 3, 21, 9, 13, 16) - index * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
      return { ...scan, event_date: date, timezone_date: date };
    });
    const result = parseKec(p, NUMBER);
    expect(result.history_truncated).toBe(true);
    expect(result.events).toHaveLength(300);
    expect(result.events![0]!.time).toBe('2026-04-21T09:13:16+00:00');
    expect(KEC_MAX_BYTES).toBeLessThanOrEqual(512 * 1024);
  });

  it('keeps generic uploaded references usable only through an explicit KEC lookup', () => {
    expect(normalizeKecNumber(' kecsynth39057186240 ')).toBe(NUMBER);
    expect(normalizeKecNumber('YT2607310964285612')).toBe('YT2607310964285612');
    for (const raw of ['', 'ABC', 'ABCDEFGHI', '3905,7186', 'A'.repeat(100)]) {
      expect(() => normalizeKecNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('KEC eCommerce status evidence', () => {
  it('does not read depot sorting as a failed delivery from the category name', () => {
    for (const code of ['lastmile_first_delivery_attempt', 'lastmile_second_delivery_attempt']) {
      expect(kecStage(code, 'Indoor Sorting - Ready For Delivery')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
      expect(statusMap.stage(code, 'Indoor Sorting - Ready For Delivery')).toBe('in_transit');
    }
    expect(kecStage('lastmile_first_delivery_attempt', 'Delivery attempt failed')?.stage).toBe('failed_attempt');
    expect(statusMap.stage('lastmile_first_delivery_attempt', 'Delivery attempt failed')).toBeUndefined();
  });

  it('does not promote a code with unknown wording into a delivery', () => {
    expect(kecStage('lastmile_delivered', 'Synthetic processing notice')).toBeNull();
    expect(statusMap.stage('lastmile_delivered', 'Synthetic processing notice')).toBeUndefined();
  });
});
