import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseReply } from './parser.js';

const found = readFileSync(new URL('./fixtures/found.html', import.meta.url), 'utf8');
const number = '21115688316';

describe('Garudavega public tracking reply', () => {
  it('reads the dated scans from the public sample, once each and without the forecast', () => {
    const result = parseReply(found, number);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update_local: '2026-02-04T10:31:00' });
    expect(result.events).toHaveLength(16);
    expect(result.events!.filter(event => event.description === 'OK DELIVERY')).toHaveLength(1);
    expect(result.events!.some(event => /expected arrival/i.test(event.description ?? ''))).toBe(false);
    expect(result.events!.find(event => event.description === 'HANDED OVER TO AIRLINE'))
      .toMatchObject({ local_time: '2026-02-02T22:30:00', stage: 'in_transit', stage_source: 'carrier_map' });
    // Every row of the sample has a stage, so a parcel between two hubs never reads unknown.
    expect(result.events!.every(event => event.stage)).toBe(true);
  });

  it('answers a missing shipment only when the notice repeats the number', () => {
    const missing = (shown: string) => `<div class="track-error-box is-notfound"><span class="state-badge">Not found</span><h4>${shown}</h4></div>`;
    expect(() => parseReply(missing(number), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseReply(missing('ANOTHER'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a reply for another number and an unexpected page', () => {
    expect(() => parseReply(found, 'WRONG')).toThrow();
    expect(() => parseReply('<html>Service unavailable</html>', number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});
