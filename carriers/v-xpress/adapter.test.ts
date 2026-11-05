import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { isVXpressReference } from '../../core/detection/vXpress.js';
import { parseVXpress } from './parser.js';
import { statusMap, vXpressStage } from './status.js';

const NUMBER = '9746825136';
const fixture = () => readFileSync(new URL('./fixtures/tracking.html', import.meta.url), 'utf8');
const pair = (date: string, detail: string) => `<tr><td>Date</td><td>${date}</td><td>Details</td><td>${detail}</td></tr><tr><td>Location</td><td>PRIVATE</td></tr>`;
describe('V-Xpress guest docket tracker', () => {
  it('binds both whole identities and projects logistics without contacts, trip references or proof updates', () => {
    const result = parseVXpress(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-07-04T14:15', expected_delivery: null });
    expect(result.events!.map(event => event.description)).toEqual(['Delivered', 'Out for delivery', 'Arrived at delivery branch', 'Dispatch recorded', 'Loaded for transport', 'Unloaded at facility', 'Package Labels Printed', 'All Package Label Generated']);
    expect(result.events!.every(event => event.local_time && !event.time && !event.location)).toBe(true);
    expect(result.events!.at(-1)!.stage).toBe('registered'); expect(result.events![3]!.stage).toBeUndefined();
    expect(result).not.toHaveProperty('delivered_at'); expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example\.invalid|X123|9746825136/);
  });
  it('requires exact absence and rejects mixed, mismatched and ambiguous shipments', () => {
    expect(() => parseVXpress('<div><table><tr><td>Docket Not Found......</td></tr></table></div>', NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const html of ['Docket not found', 'Unavailable', fixture() + 'Docket Not Found......', fixture() + fixture(),
      fixture().replace(`No.</span>${NUMBER}`, `No.</span>${NUMBER}1`), fixture().replace(`No. ${NUMBER}`, `No. 1${NUMBER}`),
      fixture().replace(`LR ${NUMBER}`, `LR 1${NUMBER}`)]) expect(() => parseVXpress(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('validates clocks, noon/midnight, all row pairs and terminal agreement', () => {
    for (const html of [fixture().replace('03-Jul-2026 06:00 AM', '31-Feb-2026 06:00 AM'),
      fixture().replace('03-Jul-2026 06:00 AM', '03-Jul-2026 13:00 AM'), fixture().replace('<td>Location</td>', '<td>Place</td>'),
      fixture().replace('<span>Current Status</span>Delivered', '<span>Current Status</span>In transit')]) {
      expect(() => parseVXpress(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const result = parseVXpress(fixture().replace('03-Jul-2026 06:00 AM', '03-Jul-2026 12:00 AM').replace('03-Jul-2026 08:00 AM', '03-Jul-2026 12:00 PM'), NUMBER);
    expect(result.events!.at(-1)!.local_time).toBe('2026-07-03T00:00');
    expect(result.events!.find(event => event.description === 'Loaded for transport')!.local_time).toBe('2026-07-03T12:00');
  });
  it('keeps an unfamiliar detail generic and a bound administrative-only history inconclusive', () => {
    const extra = pair('04-Jul-2026 11:00 AM', 'New logistics entry PRIVATE contact@example.invalid');
    const result = parseVXpress(fixture().replace('<!-- EXTRA -->', extra), NUMBER);
    expect(result.events!.find(event => event.description === 'Tracking update')).toMatchObject({ local_time: '2026-07-04T11:00' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example\.invalid/);
    const empty = fixture().replace(/<!-- HISTORY_START -->[\s\S]*?<!-- HISTORY_END -->/, pair('04-Jul-2026 11:00 AM', 'POD Copy Received'));
    expect(() => parseVXpress(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'parcel_found' }));
  });
  it('validates every row before deduplication and the event cap', () => {
    const extra = Array.from({ length: 101 }, (_, index) => pair(`02-Jul-2026 ${String(Math.floor(index / 60) + 1).padStart(2, '0')}:${String(index % 60).padStart(2, '0')} AM`, 'New entry')).join('');
    const html = fixture().replace('<!-- EXTRA -->', extra);
    const result = parseVXpress(html, NUMBER); expect(result.events).toHaveLength(100); expect(result.history_truncated).toBe(true);
    expect(() => parseVXpress(html.replace('02-Jul-2026 01:00 AM', 'bad clock'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseVXpress(fixture().replace('<!-- EXTRA -->', pair('02-Jul-2026 01:00 AM', 'New entry').repeat(501)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps shared-number detection and recognition unchanged while gating named handoffs', () => {
    for (const number of [NUMBER, '9746825']) {
      expect(isVXpressReference(number)).toBe(true); expect(hasDirectHandoffAdapter('v-xpress', number)).toBe(true);
      expect(detectCarrierMatch(number).candidates).not.toContain('v-xpress');
      expect(recognitionCandidates(number).map(candidate => candidate.carrier)).not.toContain('v-xpress');
    }
    for (const number of ['0'.repeat(7), '0'.repeat(10), '97468251', 'IW864209751GB']) expect(isVXpressReference(number)).toBe(false);
    expect(vXpressStage(null, 'only data dispatch')).toBeUndefined(); expect(vXpressStage(null, 'Dispatch recorded')).toBeUndefined();
    expect(statusMap.gaps[0]!.wording).toBe('dispatch recorded');
  });
});
