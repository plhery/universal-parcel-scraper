import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTracking } from './parser.js';

const fixture = (file: string) => readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url), 'utf8');
describe('USEA EXPRESS public tracking', () => {
  it('reads the public shipment', () => {
    const result = parseTracking(fixture('found'), 'USEA38270400484097', 200);
    expect(result.current_stage).toBe('delivered');
    expect(result.events?.length).toBeGreaterThan(0);
  });
  it('rejects a different identity', () => {
    expect(() => parseTracking(fixture('found'), 'USEA99999999999990', 200)).toThrow();
  });
  it('recognizes the observed absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), 'USEA99999999999990', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });
  it('keeps an unavailable endpoint distinct from an unknown shipment', () => {
    expect(() => parseTracking('<html>Unavailable</html>', 'USEA38270400484097', 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('rejects a changed response', () => {
    expect(() => parseTracking('<html></html>', 'USEA38270400484097', 200)).toThrow();
  });

  it('reads a wording its map lacks by the shared wording rules', () => {
    // Synthetic: the sample's newest row reworded.
    const reply = JSON.parse(fixture('found'));
    reply.data[0].events[0].content = 'Returned to sender';
    expect(parseTracking(JSON.stringify(reply), 'USEA38270400484097', 200)).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language' });
  });
});
