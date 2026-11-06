import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_BYTES, normalizeXcargoNumber, parseXcargo, xcargoVisitorToken } from './parser.js';
import { statusMap, xcargoState } from './status.js';

const NUMBER = '9000000000000017';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const missing = () => JSON.parse(readFileSync(new URL('./fixtures/unknown.json', import.meta.url), 'utf8'));
const token = (claims: unknown) => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.SYNTHETIC_SIGNATURE';

describe('X-Cargo group tracking parser', () => {
  it('binds both canonical numbers and every order row, retaining stated offsets and safe fields only', () => {
    const result = parseXcargo(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', status: 'delivered', provider_code: '360',
      last_status_text: 'Delivered', last_update: '2026-05-04T10:00:00-06:00', expected_delivery: null });
    expect(result.events).toHaveLength(10);
    expect(result.events![0]).toMatchObject({ time: '2026-05-04T10:00:00-06:00', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.filter(row => row.time === '2026-05-03T12:00:00-06:00').map(row => row.provider_code)).toEqual(['310', '311']);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|example|2040|9000000000000017|Fontylink|contact|latitude|longitude|proof|MYM/);
    expect(result).not.toHaveProperty('delivery_carrier'); expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('does not replace a stated offset with the catalog Colombia zone', () => {
    const data = fixture(); data.data[0].gmt_offset = 'GMT+02:00';
    const result = parseXcargo(data, NUMBER);
    expect(result.events!.at(-1)?.time).toBe('2026-05-01T08:00:00+02:00');
    expect(result.events![0]?.time).toBe('2026-05-04T10:00:00-06:00');
    expect(result.events!.some(row => row.time?.endsWith('-05:00'))).toBe(false);
  });

  it('requires exact whole identities and group scope before reading history', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.tracking_number += '9'; },
      (p: ReturnType<typeof fixture>) => { p.reference_tracking_number = '9000000000000018'; },
      (p: ReturnType<typeof fixture>) => { p.data[0].order_id = 1002; },
      (p: ReturnType<typeof fixture>) => { p.id = Number.MAX_SAFE_INTEGER + 1; },
      (p: ReturnType<typeof fixture>) => { p.data[0].status_code.code = '360'; },
      (p: ReturnType<typeof fixture>) => { p.data[0].status_code.code_type = 'last_mile'; },
    ]) { const data = fixture(); mutate(data); expect(() => parseXcargo(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' })); }
    const other = fixture(); other.primary_client_name = 'OTHER_PLATFORM_CLIENT';
    expect(() => parseXcargo(other, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'unsupported_network' }));
  });

  it('recognizes only the exact HTTP404 absence envelope, not an empty or mixed success', () => {
    expect(() => parseXcargo(missing(), NUMBER, 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseXcargo(missing(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXcargo({ ...missing(), data: [] }, NUMBER, 404)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture(); empty.data = [];
    expect(() => parseXcargo(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('validates calendar dates, seconds and the complete stated GMT offset', () => {
    for (const [field, value] of [['created_at', '2026-02-30 10:00:00'], ['created_at', '2026-05-04 24:00:00'],
      ['created_at', '2026-05-04 10:00:60'], ['created_at', '2026-05-04'], ['gmt_offset', 'GMT-06:60'],
      ['gmt_offset', 'GMT+14:01'], ['gmt_offset', 'America/Bogota'], ['gmt_offset', null]]) {
      const data = fixture(); data.data[0][field as string] = value;
      expect(() => parseXcargo(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('distinguishes route assignment, actual dispatch, failed delivery and a return to the station', () => {
    expect(xcargoState('301')?.stage).toBe('in_transit'); expect(xcargoState('303')?.stage).toBe('out_for_delivery');
    expect(xcargoState('311')?.stage).toBe('failed_attempt'); expect(xcargoState('206')?.stage).toBe('in_transit');
    expect(statusMap.stage('360', 'ignored private wording')).toBe('delivered');
  });

  it('keeps unmapped scans generic/partial and validates all source rows before dedupe and the cap', () => {
    const unknown = fixture(); unknown.data.at(-1).status_code.code = 999;
    const result = parseXcargo(unknown, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', history_truncated: true, last_status_text: 'Tracking update' });
    expect(result.events![0]?.stage).toBeUndefined();
    const repeated = fixture(); repeated.data.push({ ...repeated.data[9], id: 5000, notes: 'DIFFERENT_PRIVATE_NOTE' });
    expect(parseXcargo(repeated, NUMBER).events).toHaveLength(10);
    const capped = fixture(); capped.data = Array.from({ length: 101 }, (_, i) => ({ ...capped.data[0],
      created_at: '2026-05-01 08:' + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') }));
    expect(parseXcargo(capped, NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseXcargo(capped, NUMBER).events).toHaveLength(100);
    capped.data[0].order_id = 1002;
    expect(() => parseXcargo(capped, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const large = fixture(); large.data = Array(501).fill(large.data[0]);
    expect(() => parseXcargo(large, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(MAX_BYTES).toBe(1024 * 1024);
  });

  it('uses narrow input validation without reconstructing aliases or accepting partial numbers', () => {
    expect(normalizeXcargoNumber('9000 0000-0000 0017')).toBe(NUMBER);
    for (const value of ['900000000000001', '90000000000000170', 'XC' + NUMBER, '../' + NUMBER, 'x'.repeat(65)]) {
      expect(() => normalizeXcargoNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('reads one fresh visitor token and rejects stale, malformed, ambiguous or challenged configuration', () => {
    const good = token({ exp: 2000000000 });
    expect(xcargoVisitorToken('const value="' + good + '";', 1000)).toBe(good);
    expect(xcargoVisitorToken(good + '\n' + good, 1000)).toBe(good);
    expect(() => xcargoVisitorToken(good, 2000000000001)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    for (const script of ['', 'eyJinvalid.invalid.invalid', good + ' ' + token({ exp: 2100000000 })]) {
      expect(() => xcargoVisitorToken(script, 1000)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => xcargoVisitorToken('<title>Just a moment</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
});
