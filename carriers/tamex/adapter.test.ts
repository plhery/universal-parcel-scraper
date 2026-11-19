import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('Tamex tracking', () => {
  it('reads the public shipment with its latest carrier clock', () => {
    const result = parseTracking(fixture('found'), '32796769098312', 200);
    expect(result.current_stage).toBe('delivered');
    expect(result.last_update_local).toBe('2026-08-18');
    expect(result.events).toHaveLength(6);
  });

  it('rejects a result for another shipment', () => {
    expect(() => parseTracking(fixture('found'), '30000000000000', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes the carrier\'s explicit absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), '30000000000000', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('treats an unavailable route as a tracking failure', () => {
    expect(() => parseTracking('<html>Unavailable</html>', '30000000000000', 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
