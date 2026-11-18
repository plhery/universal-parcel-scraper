import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTracking } from './parser.js';

const fixture = (file: string) => readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url), 'utf8');
describe('Bigfoot Express Freight public tracking', () => {
  it('reads the public shipment', () => {
    const result = parseTracking(fixture('found'), 'WB7058138', 200);
    expect(result.current_stage).toBe('delivered');
    expect(result.events?.length).toBeGreaterThan(0);
  });
  it('rejects a different identity', () => {
    expect(() => parseTracking(fixture('found'), 'ZZZ999990', 200)).toThrow();
  });
  it('recognizes the observed absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), 'ZZZ999990', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });
  it('keeps an unavailable endpoint distinct from an unknown shipment', () => {
    expect(() => parseTracking('<html>Unavailable</html>', 'WB7058138', 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('rejects a changed response', () => {
    expect(() => parseTracking('<html></html>', 'WB7058138', 200)).toThrow();
  });
});
