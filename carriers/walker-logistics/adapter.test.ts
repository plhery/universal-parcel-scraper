import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWalkerLogistics } from './parser.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8'));
}

describe('Walker Logistics Tempo reply', () => {
  it('reads dated consignment scans and the offset in the reply', () => {
    const result = parseWalkerLogistics(fixture('found'), 'BYDEZI502002');
    expect(result.events).toHaveLength(6);
    expect(result.current_stage).toBe('delivered');
    expect(result.delivered_at).toBe('2024-10-16T13:48:44.173+13:00');
    expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery', location: 'Mangere, Auckland' });
  });

  it('rejects an unrelated consignment and an incomplete response', () => {
    expect(() => parseWalkerLogistics(fixture('found'), 'ZZZZZZ000000')).toThrow();
    expect(() => parseWalkerLogistics({ consignmentFound: false }, 'ZZZZZZ000000')).toThrow();
  });

  it('accepts a matching explicit negative', () => {
    expect(() => parseWalkerLogistics(fixture('missing'), 'ZZZZZZ000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });
});
