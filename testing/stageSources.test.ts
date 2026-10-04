import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult, resolveResult, stageSource } from '../index.js';
import { event, localEvent, result } from '../providers/shared/result.js';

const TIME = '2026-01-01T12:00:00Z';

describe('classification provenance', () => {
  it.each([
    ['Unrecognized carrier message', undefined, 'pending', 'none'],
    ['Sorted in regional hub', undefined, 'in_transit', 'wording:language'],
    ['Item received for transport', undefined, 'accepted', 'wording:language'],
    ['Provider milestone 42', 'InTransit', 'in_transit', 'carrier_map'],
    ['Unrecognized carrier message', 'UnrecognizedCategory', 'pending', 'none'],
    ['Delivered to local carrier', 'Delivered', 'in_transit', 'wording:provider'],
    ['Delivered, signed by SYNTHETIC RECIPIENT', undefined, 'delivered', 'wording:provider'],
  ])('retains the decision for %s (%s)', (description, category, stage, source) => {
    const parsed = event(TIME, description, category)!;
    expect(parsed).toMatchObject({ stage, stage_source: source });
    const normalized = normalizeCarrierResult({ events: [parsed] });
    expect(resolveResult(normalized).events[0]).toMatchObject({ stage, stage_source: source });
    if (stage === 'delivered') expect(parsed.description).toBe('Delivered');
  });

  it('retains wording provenance for local clocks and the milestone chosen for the summary', () => {
    const movement = localEvent('2026-01-01T11:00:00', 'Sorted in regional hub')!;
    const unknown = localEvent('2026-01-01T12:00:00', 'Unrecognized carrier message')!;
    expect(unknown).toMatchObject({ stage: 'pending', stage_source: 'none' });
    expect(result([unknown, movement], 'Postal Ninja')).toMatchObject({
      current_stage: 'in_transit', current_stage_source: 'wording:language',
    });
    expect(result([unknown], 'Postal Ninja')).toMatchObject({ current_stage: 'pending', current_stage_source: 'none' });
  });

  it('keeps legacy adapter maps while preserving explicit pending and wording decisions', () => {
    expect(stageSource('accepted', 'Vague description')).toBe('carrier_map');
    expect(stageSource('pending', 'Unrecognized carrier message', 'none')).toBe('none');
    expect(stageSource('in_transit', 'Sorted in regional hub', 'wording:provider')).toBe('wording:provider');
    expect(stageSource('', 'Sorted in regional hub', 'carrier_map')).toBe('wording:language');
    for (const invalid of ['', 42, 'other', 'wording:', `wording:${'x'.repeat(100)}`]) {
      expect(stageSource('accepted', 'Vague description', invalid)).toBe('carrier_map');
    }
  });
});
