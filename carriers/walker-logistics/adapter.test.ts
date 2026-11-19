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

  it('reads a delivery that did not succeed by its words, and never as a delivery', () => {
    // Synthetic rows on the public sample: Tempo's outcome beside the step, and the reason the page shows.
    const found = fixture('found') as { eventResults: Record<string, unknown>[] };
    const row = (eventTypeName: string, eventOutcomeId: number, eventOutcome: string, reasonName: string | null) => ({
      eventTypeName, eventOutcomeId, eventOutcome, reasonName, finished: '2024-10-17T09:00:00+13:00', location: 'Example Depot' });
    const read = (newest: Record<string, unknown>) =>
      parseWalkerLogistics({ ...found, eventResults: [newest, ...found.eventResults.slice(1)] }, 'BYDEZI502002');
    expect(read(row('Delivery', 2, 'Failed', 'No One Home'))).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      current_stage_source: 'wording:language', last_status_text: 'Delivery — Failed — No One Home' });
    const unread = read(row('Delivery', 1, 'Succeeded with Errors', null));
    expect(unread.status).toBe('unknown');
    expect(unread.delivered_at).toBeUndefined();
    // A pickup that failed is the sender's, not an attempt to deliver.
    expect(read(row('Pickup', 2, 'Failed', 'Not Ready')).current_stage).toBeUndefined();
  });

  it('rejects an unrelated consignment and an incomplete response', () => {
    expect(() => parseWalkerLogistics(fixture('found'), 'ZZZZZZ000000')).toThrow();
    expect(() => parseWalkerLogistics({ consignmentFound: false }, 'ZZZZZZ000000')).toThrow();
  });

  it('accepts a matching explicit negative', () => {
    expect(() => parseWalkerLogistics(fixture('missing'), 'ZZZZZZ000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });
});
