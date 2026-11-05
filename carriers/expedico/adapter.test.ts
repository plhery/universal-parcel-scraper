import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deliveryHandoff, hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { normalizeExpedicoNumber, parseExpedico } from './parser.js';

const NUMBER = '9734628105691', PARTNER = '9746825103681427F6048';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
const absent = () => ({ data: { tracking: [{ code: NUMBER, result: 'NOT_FOUND', id: null, trackingCode: null,
  carrier: null, packetState: null, events: null }] } });

describe('Expedico history', () => {
  it('binds the request, own id and declared national-service barcode while preserving stated offsets', () => {
    const result = parseExpedico(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'delivered',
      last_update: '2026-07-04T13:30:00+03:00', weight_kg: 1.25, delivery_carrier: 'fan-courier', delivery_tracking_number: PARTNER });
    expect(result.events).toHaveLength(4);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'registered']);
    expect(result.events![3]).toMatchObject({ time: '2026-07-01T10:00:00Z', provider_code: 'created' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(result).not.toHaveProperty('destination_country');
  });

  it('reads a recorded partner alias without shortening it into an unsupported FAN AWB', () => {
    const data = fixture(); data.data.tracking[0].code = PARTNER;
    const result = parseExpedico(data, PARTNER);
    expect(result.current_stage).toBe('delivered'); expect(result.delivery_tracking_number).toBe(PARTNER);
    expect(hasDirectHandoffAdapter('fan-courier', PARTNER)).toBe(false);
    expect(deliveryHandoff('expedico', PARTNER, result)).toBeNull();
    expect(hasDirectHandoffAdapter('fan-courier', NUMBER)).toBe(true);
    expect(deliveryHandoff('expedico', NUMBER, { ...result, delivery_tracking_number: NUMBER })).toEqual({ carrier: 'fan-courier', number: NUMBER, basis: 'partner' });
    data.data.tracking[0].trackingCode = '9746825103681427F6049';
    expect(() => parseExpedico(data, PARTNER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts only the bound empty NOT_FOUND signature, separately from GraphQL errors and partial data', () => {
    expect(() => parseExpedico(absent(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const mixed = { data: { tracking: [{ ...absent().data.tracking[0], events: [] }] } };
    expect(() => parseExpedico(mixed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseExpedico({ ...fixture(), errors: [{ message: 'Service unavailable' }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseExpedico({ errors: [{ message: 'Rate limit exceeded' }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseExpedico({ errors: [{ message: 'Verification required' }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const wrong = absent(); wrong.data.tracking[0]!.code += '0';
    expect(() => parseExpedico(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects mismatched identity, duplicate records, contradictory states and invalid clocks', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.data.tracking[0].id += '0'; },
      (p: ReturnType<typeof fixture>) => { p.data.tracking.push(p.data.tracking[0]); },
      (p: ReturnType<typeof fixture>) => { p.data.tracking[0].packetState.sys = 'in_hub'; },
      (p: ReturnType<typeof fixture>) => { p.data.tracking[0].events[0].occuredOn = '2026-02-30T10:00:00Z'; },
      (p: ReturnType<typeof fixture>) => { p.data.tracking[0].events[0].occuredOn = '2026-07-01T24:00:00'; },
    ]) {
      const data = fixture(); mutate(data);
      expect(() => parseExpedico(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps unoffset clocks local and new state codes visible without exposing arbitrary partner comments', () => {
    const data = fixture(), row = data.data.tracking[0];
    row.packetState.sys = row.events[3].packetState.sys = 'new_phase';
    row.events[3].carrierStateDescription = 'PRIVATE RECIPIENT COMMENT'; row.events[3].occuredOn = '2026-07-04T13:30:00';
    const result = parseExpedico(data, NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.events![0]).toMatchObject({ local_time: '2026-07-04T13:30:00', provider_code: 'new_phase', description: 'new phase' });
    expect(result.events![0]).not.toHaveProperty('time'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('caps distinct events and validates rows beyond that cap', () => {
    const data = fixture(), row = data.data.tracking[0];
    row.events = Array.from({ length: 101 }, (_, i) => ({ ...row.events[3], occuredOn: new Date(Date.UTC(2026, 6, 4, 0, i, 0)).toISOString() }));
    expect(parseExpedico(data, NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseExpedico(data, NUMBER).events).toHaveLength(100);
    row.events[0].occuredOn = 'invalid';
    expect(() => parseExpedico(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeExpedicoNumber(' 9734628 105691 ')).toBe(NUMBER);
    expect(() => normalizeExpedicoNumber('TRACKING99')).toThrow(expect.objectContaining({ reason: 'unsupported_reference' }));
  });
});
