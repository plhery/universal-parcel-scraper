import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');

describe('Moran Transportation tracking', () => {
  it('reads the public shipment with its latest carrier clock', () => {
    const result = parseTracking(fixture('found'), '1003306592', 200);
    expect(result.current_stage).toBe('delivered');
    expect(result.last_update_local).toBe('2024-04-02T13:07:00');
    expect(result.events).toHaveLength(9);
  });

  it('reads every receiving terminal alike, and a truck en route during the round as the round', () => {
    const number = /<pronumb>(\d+)<\/pronumb>/.exec(fixture('found'))![1]!;
    const stages = (xml: string) => parseTracking(xml, number, 200).events!.map(event => `${event.description} ${event.stage}`);
    expect(stages(fixture('found')).slice(0, 5)).toEqual(['Delivered delivered', 'En-route out_for_delivery',
      'Out For Delivery out_for_delivery', 'Manifested in_transit', 'Received At Moran Fort Wayne in_transit']);
    expect(stages(fixture('found').replace('Received At Moran Fort Wayne', 'Received At Moran Indianapolis'))[4])
      .toBe('Received At Moran Indianapolis in_transit');
    expect(stages(fixture('found')).at(-2)).toBe('Picked Up accepted');
  });

  it('rejects a result for another shipment', () => {
    expect(() => parseTracking(fixture('found'), '0000000000', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes the carrier\'s explicit absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), '0000000000', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('treats an unavailable route as a tracking failure', () => {
    expect(() => parseTracking('<html>Unavailable</html>', '0000000000', 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
