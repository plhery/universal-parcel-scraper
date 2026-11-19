import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTuskLogistics } from './parser.js';

const found = readFileSync(new URL('./fixtures/found.html', import.meta.url), 'utf8');
const number = 'TUSK0COA8D56NUP0';
const unknownNumber = 'TUSKZZZZZZZZZZZZ';

describe('Tusk Logistics guest page', () => {
  it('binds the shipment and reads dated scans in page order without a guessed offset', () => {
    const result = parseTuskLogistics(found, number);
    expect(result.events).toHaveLength(13);
    expect(result.current_stage).toBe('delivered');
    expect(result.events?.[0]).toEqual({
      local_time: '2026-10-19T09:49:00', description: 'Your Parcel has been delivered', location: 'East Greenwich, RI',
      stage: 'delivered', stage_source: 'carrier_map',
    });
  });

  it('separates the explicit negative, unrelated result and unfinished page', () => {
    expect(() => parseTuskLogistics('<h1>Shipment not found!</h1>', unknownNumber)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTuskLogistics(found, unknownNumber)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTuskLogistics('<p>Loading...</p>', number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});
