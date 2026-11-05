import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dateLocalClocks } from '../../places/clocks.js';
import { parseFrontierCa } from './parser.js';
import { frontierCaStage } from './status.js';
const NUMBER = '97468251';
const fixture = () => readFileSync(new URL('./fixtures/tracking.xml', import.meta.url), 'utf8');
describe('Frontier Courier FACTS trace', () => {
  it('binds the whole PRO, separates dispatch from custody and excludes private trace fields', () => {
    const result = parseFrontierCa(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', provider_code: '80', last_update: null, last_update_local: '2026-07-04T16:09:00', expected_delivery: null });
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'accepted', 'registered', 'registered']);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true); expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(result).not.toHaveProperty('weight_kg');
    expect(dateLocalClocks('frontier-ca', result).events![0]).toMatchObject({ local_time: '2026-07-04T16:09:00', time: '2026-07-04T16:09:00-06:00', time_zone_basis: 'place' });
  });
  it('accepts only the exact number-bound error and rejects mixed records or another PRO', () => {
    const error = `<error><errormessage>Invalid pronumber ${NUMBER}</errormessage></error>`;
    expect(() => parseFrontierCa(error, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFrontierCa(error.replace(NUMBER, NUMBER + '1'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFrontierCa(fixture().replace(`<pronumb>${NUMBER}</pronumb>`, '<pronumb>97468252</pronumb>'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFrontierCa(fixture().replace('<shiphists>', '<error>failed</error><shiphists>'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('rejects malformed clocks, ambiguous XML and contradictory delivery claims', () => {
    for (const [from, to] of [
      ['2026-07-04', '2026-02-30'], ['16:09', '25:09'], ['<prodelivered>Yes</prodelivered>', '<prodelivered>No</prodelivered>'],
      ['<lifecycle>Delivered</lifecycle>', '<lifecycle>In Transit</lifecycle>'],
      ['<histcode>Delivered</histcode>', '<histcode>Picked Up</histcode>'],
      ['<pronumb>', '<pronumb>97468251</pronumb><pronumb>'],
    ] as const) expect(() => parseFrontierCa(fixture().replace(from, to), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFrontierCa(fixture().replace('<lifecycle>Delivered</lifecycle>', '<lifecycle>Quote</lifecycle>'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('keeps unrecognized scans and validates rows beyond the cap', () => {
    const row = '<shiphist><histcode>Administrative notice</histcode><histdate>2026-07-03</histdate><histtime>12:00</histtime><histremarks>PRIVATE address</histremarks></shiphist>';
    const html = fixture().replace('</shiphists>', Array.from({ length: 101 }, (_, i) => row.replace('notice', `notice ${i}`)).join('') + '</shiphists>');
    const result = parseFrontierCa(html, NUMBER); expect(result.events).toHaveLength(100); expect(result.history_truncated).toBe(true); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(() => parseFrontierCa(html.replace('notice 100</histcode><histdate>2026-07-03', 'notice 100</histcode><histdate>invalid'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(frontierCaStage('NEW', 'Delivered')).toBeUndefined(); expect(frontierCaStage('80', 'Picked Up')).toBeUndefined();
  });
});
