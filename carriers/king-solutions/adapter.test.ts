import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseReply } from './parser.js';

const found = readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8');
const number = 'SO000014701SO';

describe('King Solutions public tracking reply', () => {
  it('reads the dated scans from the public sample', () => {
    const result = parseReply(found, number);
    expect(result.events).toHaveLength(5);
    expect(result.current_stage).toBe('delivered');
  });

  it('leaves out only a note naming who signed, and marks the history incomplete', () => {
    const reply = JSON.parse(found);
    const notes = reply.trackResults[0].externalNotes;
    notes.unshift({ ...notes[0], comments: 'Delivered, signed by A Neighbour', traceDate: notes[0].traceDate + 60_000 });
    const result = parseReply(JSON.stringify(reply), number);
    expect(result).toMatchObject({ current_stage: 'delivered', history_truncated: true });
    expect(result.events).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain('Neighbour');
    expect(parseReply(found, number)).not.toHaveProperty('history_truncated');
  });

  it('rejects a reply for another number and an unexpected page', () => {
    expect(() => parseReply(found, 'WRONG')).toThrow();
    expect(() => parseReply('<html>Service unavailable</html>', number)).toThrow();
  });
});
