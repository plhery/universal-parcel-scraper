import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { freightwaysGlobalUrl, parseFreightwaysGlobal } from './parser.js';
const NUMBER = 'NZC974682511', GSS = 'GSS97468251036814', ACCOUNT = '0004321-' + NUMBER;
const fixture = () => readFileSync(new URL('./fixtures/tracking.html', import.meta.url), 'utf8');
describe('Freightways Global inbound history', () => {
  it('binds whole aliases and its own forwarding leg while preserving local scan clocks', () => {
    const result = parseFreightwaysGlobal(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-07-04T10:54:00', weight_kg: 1.25, destination_country: 'NZ' });
    expect(result.events).toHaveLength(7);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', undefined, undefined, 'registered']);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(JSON.stringify(result)).not.toContain(NUMBER + '01');
    expect(result).not.toHaveProperty('delivery_tracking_number'); expect(result).not.toHaveProperty('delivery_carrier');
    expect(deliveryHandoff('freightways-global', NUMBER, result)).toBeNull();
    for (const alias of [GSS, ACCOUNT]) expect(parseFreightwaysGlobal(fixture(), alias)).toMatchObject({ canonical_tracking_number: NUMBER, events: result.events });
    expect(freightwaysGlobalUrl(ACCOUNT.replace('-', ''))).toContain(ACCOUNT);
  });
  it('rejects mixed identities, another parcel, changed clocks and another service', () => {
    for (const [from, to, kind] of [
      [`Tracking: ${NUMBER}`, 'Tracking: NZC974682512', 'schema'],
      [ACCOUNT, '0004321-NZC974682512', 'schema'],
      [NUMBER + '01 (Parcel# 1)', 'NZC97468251201 (Parcel# 1)', 'schema'],
      ['10:54 am', '25:54 am', 'schema'], ['Saturday, 4 July 2026', 'Friday, 30 February 2026', 'schema'],
      ['IsFGInternational', 'Other account', 'indeterminate'], ['<div class="col-md-3">1</div>', '<div class="col-md-3">2</div>', 'indeterminate'], ['Customs cleared in NZ', 'Processing update', 'indeterminate'],
    ] as const) expect(() => parseFreightwaysGlobal(fixture().replace(from, to), NUMBER)).toThrow(expect.objectContaining({ kind }));
  });
  it('keeps expired/unknown inconclusive and never mistakes a missing history for absence', () => {
    expect(() => parseFreightwaysGlobal('<h3>Search</h3><p>No results found</p>', NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'expired_or_unknown' }));
    expect(() => parseFreightwaysGlobal(fixture() + '<p>No results found</p>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(statusMapAnswer({ carrier: 'freightways-global', description: 'Customs Data received – shipment on route to destination country' })).toMatchObject({ kind: 'intentional_gap' });
    expect(detectCarrierMatch(NUMBER).carrier).toBe('dai-post');
    expect(recognitionCandidates(NUMBER).map(item => item.carrier)).not.toContain('freightways-global');
  });
  it('validates beyond the projection cap and preserves unknown states without copying contacts', () => {
    const extra = Array.from({ length: 101 }, (_, i) => `<tr><td></td><td class="time">1:00 am</td><td>Processing ${i}</td><td></td><td></td></tr>`).join('');
    const html = fixture().replace('</tbody>', extra + '</tbody>');
    expect(parseFreightwaysGlobal(html, NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseFreightwaysGlobal(html, NUMBER).events).toHaveLength(100);
    expect(() => parseFreightwaysGlobal(html.replace('Processing 100', 'PRIVATE@invalid.example'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const changed = fixture().replace('Delivered', 'Processing update. Recipient: PRIVATE');
    const result = parseFreightwaysGlobal(changed, NUMBER); expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
