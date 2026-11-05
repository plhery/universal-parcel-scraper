import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parcelTrackingLinks } from '../../core/catalog/parcel.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { parseAirspeed } from './parser.js';
import { airspeedStage, statusMap } from './status.js';

const NUMBER = '974682513';
const fixture = () => readFileSync(new URL('./fixtures/tracking.html', import.meta.url), 'utf8');
const unknown = () => fixture().replace(NUMBER, '').replace(/<table id="GridViewWaybillHistory">[\s\S]*?<\/table>/, '')
  .replace('PRIVATE reference', '').replace('PRIVATE receiver address', '').replace('7/4/2026 2:15:16 PM', '').replace('Delivered', '');
describe('Airspeed cargo tracker', () => {
  it('binds the separate whole waybill, reverses the grid and preserves wall clocks without mixed remarks', () => {
    const result = parseAirspeed(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-07-04T14:15:16', expected_delivery: null });
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'accepted', undefined, 'accepted', 'registered']);
    expect(result.events!.every(event => event.local_time && !event.time && !event.location)).toBe(true);
    expect(result.events![1]!.local_time).toBe('2026-07-04T12:00:00');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example\.invalid/); expect(result).not.toHaveProperty('delivered_at');
  });
  it('ignores the empty view\'s generated booking clock and rejects unbound or mixed histories', () => {
    expect(() => parseAirspeed(unknown(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'expired_or_unknown' }));
    expect(() => parseAirspeed(fixture().replace(NUMBER, NUMBER + '1'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAirspeed(fixture().replace(NUMBER, ''), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAirspeed(unknown().replace('DESTINATION:</td><td>', 'DESTINATION:</td><td>PRIVATE'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps month/day, noon/midnight and current-summary agreement strict', () => {
    for (const [from, to] of [['7/4/2026 9:00:00 AM</td><td>For', '2/30/2026 9:00:00 AM</td><td>For'],
      ['7/4/2026 12:00:00 PM', '7/4/2026 13:00:00 PM'], ['CURRENT STATUS:</td><td>Delivered', 'CURRENT STATUS:</td><td>Picked']] as const) {
      expect(() => parseAirspeed(fixture().replace(from, to), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const midnight = parseAirspeed(fixture().replace('7/4/2026 9:00:00 AM</td><td>For', '7/4/2026 12:00:00 AM</td><td>For'), NUMBER);
    expect(midnight.events!.at(-1)!.local_time).toBe('2026-07-04T00:00:00');
    const changed = parseAirspeed(fixture().replaceAll('Delivered', 'Processing notice'), NUMBER);
    expect(changed.status).toBe('unknown'); expect(changed.events![0]!.stage).toBeUndefined();
    expect(airspeedStage(null, 'For Pick-Up')).toBe('registered'); expect(airspeedStage(null, 'Manifested')).toBeUndefined();
    expect(statusMap.gapNote!(null, 'manifested')).toBeTruthy();
  });
  it('validates every source row before deduplication and the output cap', () => {
    const row = '<tr><td>7/4/2026 1:00:00 PM</td><td>Processing notice N</td><td>PRIVATE</td></tr>';
    const extra = Array.from({ length: 101 }, (_, i) => row.replace('notice N', `notice ${i}`)).join('');
    const html = fixture().replace('<tr id="delivery">', extra + '<tr id="delivery">');
    const result = parseAirspeed(html, NUMBER); expect(result.events).toHaveLength(100); expect(result.history_truncated).toBe(true);
    expect(() => parseAirspeed(html.replace('7/4/2026 1:00:00 PM</td><td>Processing notice 0', 'bad clock</td><td>Processing notice 0'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAirspeed(fixture().replace('<tr id="delivery">', row.repeat(501) + '<tr id="delivery">'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps nine-digit detection unchanged and carries the whole waybill in its public link', () => {
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('airspeed');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('airspeed');
    expect(parcelTrackingLinks({ carrier: 'airspeed', trackingNumber: NUMBER }, 'en')[0]!.url)
      .toBe(`https://logistics.airspeed.com.ph/track/TrackingSearch.aspx?waybill=${NUMBER}`);
  });
});
