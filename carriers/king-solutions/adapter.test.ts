import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseReply } from './parser.js';

const found = readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8');

describe('King Solutions public tracking reply', () => {
  it('reads the dated scans from the public sample', () => {
    const result = parseReply(found, 'SO000014701SO');
    expect(result.events).toHaveLength(5);
    expect(result.current_stage).toBe('delivered');
  });

  it('rejects a reply for another number and an unexpected page', () => {
    expect(() => parseReply(found, 'WRONG')).toThrow();
    expect(() => parseReply('<html>Service unavailable</html>', 'SO000014701SO')).toThrow();
  });
});
