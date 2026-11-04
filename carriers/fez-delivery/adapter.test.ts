import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isFezDeliveryReference } from '../../core/detection/fezDelivery.js';
import { normalizeFezDeliveryNumber, parseFezDelivery } from './parser.js';
import { fezDeliveryStage } from './status.js';

const NUMBER = 'TZ7K04072612';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));

describe('Fez Delivery history', () => {
  it('binds the whole order, preserving dated attempts and local clocks without recipient or POD data', () => {
    const result = parseFezDelivery(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'Delivered',
      last_update: null, last_update_local: '2026-07-04T10:20:30', expected_delivery: null });
    expect(result.events).toHaveLength(4);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'exception', 'in_transit']);
    expect(result.events!.every(event => event.local_time && !event.time && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private-proof|Reason/);
    expect(fezDeliveryStage('Returned To Last Mile Hub')).toBe('exception');
  });

  it('accepts only the separate explicit absence envelope as not-found', () => {
    expect(() => parseFezDelivery({ status: 'Error', description: 'Order Not Found', history: '' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const reply of [{ status: 'Error', description: 'Order Not Found', history: [], order: fixture().order },
      { status: 'Error', description: 'Service unavailable', history: '' }]) {
      expect(() => parseFezDelivery(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseFezDelivery({ status: 'Error', description: 'Rate limit reached' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseFezDelivery({ status: 'Error', description: 'Verification required' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects another whole identity, contradictory summaries and impossible clocks', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.order.orderNo += '0'; },
      (p: ReturnType<typeof fixture>) => { p.order.orderStatusAlias = 'Dispatched'; },
      (p: ReturnType<typeof fixture>) => { p.history[0].statusCreationDate = '2026-02-30 10:20:30'; },
      (p: ReturnType<typeof fixture>) => { p.history[0].statusCreationDate = '2026-07-04 24:00:00'; },
    ]) {
      const data = fixture(); mutate(data);
      expect(() => parseFezDelivery(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = fixture(); empty.history = [];
    expect(() => parseFezDelivery(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('retains unknown codes without borrowing an old delivery and caps distinct scans', () => {
    const data = fixture(); data.history[0].orderStatus = data.history[0].orderStatusAlias = data.order.orderStatusAlias = 'New logistics phase';
    const result = parseFezDelivery(data, NUMBER);
    expect(result.status).toBe('unknown'); expect(result.events![0]).not.toHaveProperty('stage');
    data.history = Array.from({ length: 101 }, (_, index) => ({ ...data.history[0], orderStatus: `NEW-${index}` }));
    expect(parseFezDelivery(data, NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseFezDelivery(data, NUMBER).events).toHaveLength(100);
    data.history = Array.from({ length: 120 }, () => data.history[0]);
    expect(parseFezDelivery(data, NUMBER).events).toHaveLength(1);
    expect(parseFezDelivery(data, NUMBER)).not.toHaveProperty('history_truncated');
    data.history = Array.from({ length: 501 }, () => data.history[0]);
    expect(() => parseFezDelivery(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('validates calendar dates without assigning ownership to every accepted reference', () => {
    expect(normalizeFezDeliveryNumber(' tz7k 04072612 ')).toBe(NUMBER);
    expect(isFezDeliveryReference('TZ7K31022612')).toBe(false);
    expect(isFezDeliveryReference('TZ7K29022412')).toBe(true);
    expect(() => normalizeFezDeliveryNumber('<invalid>')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeFezDeliveryNumber('864209751GB')).toThrow(expect.objectContaining({ reason: 'unsupported_reference' }));
  });
});
