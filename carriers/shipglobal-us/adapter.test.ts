import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeShipglobalUsNumber, parseShipglobalUs } from './parser.js';

const NUMBER = 'FFUSA7416302';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));

describe('ShipGlobal US history', () => {
  it('binds its own waybill and retains all distinct checkpoints, including repeated delivery labels', () => {
    const result = parseShipglobalUs(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'Delivered',
      last_update: null, last_update_local: '2026-07-04T10:20:30' });
    expect(result.events).toHaveLength(4);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'in_transit', 'delivered', 'in_transit']);
    expect(result.events!.every(event => !event.time && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-proof');
    expect(result).not.toHaveProperty('delivery_carrier'); expect(result).not.toHaveProperty('timezone');
  });

  it('keeps the exact ambiguous 400 reply inconclusive, separately from malformed or success replies', () => {
    expect(() => parseShipglobalUs({ message: 'Invalid tracking number' }, NUMBER, 400)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseShipglobalUs({ message: 'Invalid tracking number' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseShipglobalUs(fixture(), NUMBER, 400)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseShipglobalUs({ response: 'error', message: 'Rate limit' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
  });

  it('rejects another whole identity, extra records, changed summaries, missing indices and impossible clocks', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.data[0].waybill += '0'; },
      (p: ReturnType<typeof fixture>) => { p.data.push(p.data[0]); },
      (p: ReturnType<typeof fixture>) => { p.data[0].CurrentStatus = 'In Transit'; },
      (p: ReturnType<typeof fixture>) => { delete p.data[0]['1']; },
      (p: ReturnType<typeof fixture>) => { p.data[0]['0'].date = '2026-02-30 10:20:30'; },
    ]) {
      const data = fixture(); mutate(data);
      expect(() => parseShipglobalUs(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps new source codes visible and caps distinct checkpoints without discarding duplicates as truncation', () => {
    const data = fixture(); data.data[0].CurrentStatus = data.data[0]['0'].status = 'New logistics phase';
    expect(parseShipglobalUs(data, NUMBER).status).toBe('unknown');
    for (let i = 4; i < 101; i++) data.data[0][i] = { ...data.data[0]['0'], description: `Logistics activity ${i}` };
    expect(parseShipglobalUs(data, NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseShipglobalUs(data, NUMBER).events).toHaveLength(100);
    expect(normalizeShipglobalUsNumber(' ffusa 7416302 ')).toBe(NUMBER);
    expect(() => normalizeShipglobalUsNumber('SG987654321')).toThrow(expect.objectContaining({ reason: 'unsupported_reference' }));
  });
});
