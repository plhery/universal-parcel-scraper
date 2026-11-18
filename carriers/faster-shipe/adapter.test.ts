import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTracking } from './parser.js';

const fixture = (file: string) => readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url), 'utf8');
describe('Faster Shipe public tracking', () => {
  it('reads the public shipment', () => {
    const result = parseTracking(fixture('found'), 'FS877284074', 200);
    expect(result.current_stage).toBe('delivered');
    expect(result.events?.length).toBe(0);
  });
  it('rejects a different identity', () => {
    expect(() => parseTracking(fixture('found'), 'FS000000000', 200)).toThrow();
  });
  it('recognizes the observed absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), 'FS000000000', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });
  it('keeps an unavailable endpoint distinct from an unknown shipment', () => {
    expect(() => parseTracking('<html>Unavailable</html>', 'FS877284074', 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('rejects a changed response', () => {
    expect(() => parseTracking('<html></html>', 'FS877284074', 200)).toThrow();
  });
});
