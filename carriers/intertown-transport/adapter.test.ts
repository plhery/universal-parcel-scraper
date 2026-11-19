import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');

describe('Intertown Transport tracking', () => {
  it('reads the public shipment with its latest carrier clock', () => {
    const result = parseTracking(fixture('found'), '10315434', 200);
    expect(result.current_stage).toBe('delivered');
    expect(result.last_update_local).toBe('2023-05-31T11:44:40');
    expect(result.events).toHaveLength(10);
  });

  it('rejects a result for another shipment', () => {
    expect(() => parseTracking(fixture('found'), '99999999', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes the carrier\'s explicit absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), '99999999', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('treats an unavailable route as a tracking failure', () => {
    expect(() => parseTracking('<html>Unavailable</html>', '99999999', 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
