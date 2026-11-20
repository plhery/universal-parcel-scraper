// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CARRIER_IDS } from '../../generated/catalog.js';
import type { CarrierResult } from '../../core/result/index.js';
import { SCOPED_WORDINGS, scopedWordingStage } from '../../core/status/scoped.js';
import { classifyEvent, type UniversalSource } from './result.js';
import { withScopedWording } from './scoped.js';

const SOURCES: readonly UniversalSource[] = ['17TRACK', 'ParcelsApp', 'Postal Ninja', 'Ship24', 'Track718', 'Track123', 'UPU'];

describe('carrier-scoped wording', () => {
  it('names catalog carriers and universal providers only', () => {
    for (const rule of SCOPED_WORDINGS) {
      expect(CARRIER_IDS as readonly string[]).toContain(rule.carrier);
      for (const provider of rule.providers ?? []) expect(SOURCES).toContain(provider);
      expect(rule.note.length).toBeGreaterThan(0);
    }
  });

  it('reads a word for its carrier and provider only', () => {
    expect(scopedWordingStage('RETURNS', { carrier: 'buffalo-ex', provider: 'ParcelsApp' })).toBe('failed_attempt');
    expect(scopedWordingStage('  returns ', { carrier: 'buffalo-ex', provider: 'ParcelsApp' })).toBe('failed_attempt');
    expect(scopedWordingStage('RETURNS', { carrier: 'buffalo-ex', provider: 'Ship24' })).toBeUndefined();
    expect(scopedWordingStage('RETURNS', { carrier: 'buffalo-ex' })).toBeUndefined();
    expect(scopedWordingStage('RETURNS', { carrier: 'la-poste', provider: 'ParcelsApp' })).toBeUndefined();
    expect(scopedWordingStage('RETURNS', { provider: 'ParcelsApp' })).toBeUndefined();
    // The whole wording, not a part of it.
    expect(scopedWordingStage('RETURNS TO SENDER', { carrier: 'buffalo-ex', provider: 'ParcelsApp' })).toBeUndefined();
    // Elsewhere the bare word keeps the shared reading.
    expect(classifyEvent('RETURNS')).toMatchObject({ stage: 'pending' });
    // The courier's morning departure on the round the parcel comes back from.
    expect(scopedWordingStage('SCAN VEHICLE DEPARTURE', { carrier: 'buffalo-ex', provider: 'ParcelsApp' })).toBe('out_for_delivery');
    expect(scopedWordingStage('SCAN VEHICLE DEPARTURE', { carrier: 'buffalo-ex', provider: 'Ship24' })).toBeUndefined();
    expect(scopedWordingStage('SCAN VEHICLE DEPARTURE', { carrier: 'la-poste', provider: 'ParcelsApp' })).toBeUndefined();
    expect(classifyEvent('SCAN VEHICLE DEPARTURE')).toMatchObject({ stage: 'in_transit' });
    // The courier collecting the parcel from BUFFALO's depot, not the sender handing it over.
    expect(scopedWordingStage('COLLECTED', { carrier: 'buffalo-ex', provider: 'ParcelsApp' })).toBe('in_transit');
    expect(classifyEvent('COLLECTED')).toMatchObject({ stage: 'accepted' });
  });

  const answer = (overrides: Partial<CarrierResult> = {}): CarrierResult => ({
    tracking_provider: 'ParcelsApp', status: 'pending', current_stage: 'pending', discovered_carrier: 'buffalo-ex',
    reported_carriers: ['Buffalo Logistics'],
    events: [
      { time: '2026-03-03T17:10:00.000Z', description: 'RETURNS', stage: 'pending', stage_source: 'none' },
      { time: '2026-03-03T06:40:00.000Z', description: 'SCAN VEHICLE DEPARTURE', stage: 'in_transit', stage_source: 'wording:language' },
    ],
    ...overrides,
  });

  it('restages the scan and the headline it leads', () => {
    const read = withScopedWording(answer({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language' }), 'ParcelsApp');
    expect(read.events?.[0]).toMatchObject({ stage: 'failed_attempt', stage_source: 'wording:provider' });
    expect(read.events?.[1]).toMatchObject({ stage: 'out_for_delivery', stage_source: 'wording:provider' });
    expect(read).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'wording:provider' });
    // With the departure the newest scan, the headline follows it out for delivery.
    const out = withScopedWording(answer({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      events: answer().events!.slice(1) }), 'ParcelsApp');
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'wording:provider' });
  });

  it('leaves other providers, carriers, legs and carrier maps alone', () => {
    const untouched = (result: CarrierResult, source: string) => expect(withScopedWording(result, source)).toBe(result);
    untouched(answer(), 'Ship24');
    untouched(answer({ discovered_carrier: 'la-poste', reported_carriers: ['La Poste'] }), 'ParcelsApp');
    untouched(answer({ discovered_carrier: undefined, reported_carriers: [] }), 'ParcelsApp');
    untouched(answer({ reported_carriers: ['Buffalo Logistics', 'Some Partner'] }), 'ParcelsApp');
    untouched(answer({ events: [{ time: '2026-03-03T17:10:00.000Z', description: 'RETURNS', stage: 'returned', stage_source: 'carrier_map' }] }), 'ParcelsApp');
    // A scan that names its own carrier is read by it.
    untouched(answer({ events: [{ time: '2026-03-03T17:10:00.000Z', description: 'RETURNS', stage: 'pending', stage_source: 'none',
      reporting_carrier: 'Universal Postal Union' }] }), 'ParcelsApp');
    const named = withScopedWording(answer({ discovered_carrier: undefined, reported_carriers: [], events: [{ time: '2026-03-03T17:10:00.000Z',
      description: 'RETURNS', stage: 'pending', stage_source: 'none', reporting_carrier: 'Buffalo Logistics' }] }), 'ParcelsApp');
    expect(named.events?.[0]).toMatchObject({ stage: 'failed_attempt', stage_source: 'wording:provider' });
  });
});
