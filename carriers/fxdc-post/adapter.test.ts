import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { fillPartialAnswer, isPartialAnswer } from '../../core/result/partial.js';
import { parseFxdcPost } from './parser.js';
import { fxdcPostStage } from './status.js';
const NUMBER = '97468251';
const fixture = () => readFileSync(new URL('./fixtures/tracking.html', import.meta.url), 'utf8');
describe('FXDC Punto Mio guest summary', () => {
  it('keeps the bound current state and day without manufacturing scan history or midnight', () => {
    const result = parseFxdcPost(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-07-04', summary_only: true, service_name: 'Punto Mio', events: [], expected_delivery: null });
    expect(result.weight_kg).toBeCloseTo(1.133980925); expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(isPartialAnswer(result)).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
  });
  it('lets a fuller matching provider history replace the partial summary without losing its service facts', () => {
    const direct = parseFxdcPost(fixture(), NUMBER);
    const richer: CarrierResult = { current_stage: 'delivered', discovered_carrier: 'fxdc-post', events: [
      { time: '2026-07-04T15:00:00-04:00', description: 'Collected', stage: 'delivered' },
      { time: '2026-07-03T09:00:00-04:00', description: 'Received', stage: 'accepted' },
    ] };
    expect(fillPartialAnswer('fxdc-post', NUMBER, direct, richer)).toMatchObject({ service_name: 'Punto Mio', events: richer.events });
    expect(fillPartialAnswer('fxdc-post', NUMBER, direct, { ...richer, current_stage: 'in_transit', events: richer.events!.map(event => ({ ...event, stage: 'in_transit' })) })).toBeNull();
  });
  it('requires matching form/result identities and actual own-service evidence', () => {
    for (const [from, to, kind] of [
      ['value="97468251"', 'value="97468252"', 'schema'], ['class="rnum">97468251', 'class="rnum">97468252', 'schema'],
      ['data-svc="pm"', 'data-svc="fx"', 'indeterminate'], ['Ontvangen in Miami', 'Unknown warehouse', 'indeterminate'],
      ['04-07-2026', '31-02-2026', 'schema'], ['<b>Afgehaald</b>', '<b>Klaar om af te halen</b>', 'schema'],
    ] as const) expect(() => parseFxdcPost(fixture().replace(from, to), NUMBER)).toThrow(expect.objectContaining({ kind }));
    const unknown = `<form action="/klant/volgen"><input name="ref" value="${NUMBER}"></form><div class="result"><div class="rcard"><h3>Dit nummer kennen we niet</h3></div></div>`;
    expect(() => parseFxdcPost(unknown, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFxdcPost(fixture() + '<p>Dit nummer kennen we niet</p>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('separates availability for pickup from collection and leaves new wording unresolved', () => {
    expect(fxdcPostStage(null, 'Klaar om af te halen')).toBe('ready_for_pickup'); expect(fxdcPostStage(null, 'Afgehaald')).toBe('delivered');
    const result = parseFxdcPost(fixture().replaceAll('Afgehaald', 'Processing update'), NUMBER); expect(result.status).toBe('unknown'); expect(result.events).toEqual([]);
  });
});
