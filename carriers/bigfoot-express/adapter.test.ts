import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTracking } from './parser.js';

const fixture = (file: string) => readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url), 'utf8');
describe('Bigfoot Express Freight public tracking', () => {
  it('reads the public shipment', () => {
    const result = parseTracking(fixture('found'), 'WB7058138', 200);
    expect(result.current_stage).toBe('delivered');
    expect(result.events?.length).toBeGreaterThan(0);
  });
  it('reads the stage the parcel has from scans that name another depot or come after it', () => {
    const stages = (reply: string) => parseTracking(reply, 'WB7058138', 200).events!.map(event => `${event.description} ${event.stage}`);
    expect(stages(fixture('found'))).toEqual([
      'Proof of delivery details captured delivered', 'Dispatched out_for_delivery',
      'Loaded for delivery from Cape Town facility out_for_delivery', 'Dispatched in_transit',
      'Loaded on manifest to Cape Town facility in_transit', 'Collection checked in at Johannesburg facility in_transit',
      'Consignment details captured accepted', 'Ready for collection accepted', 'Collected from origin address accepted',
    ]);
    const elsewhere = fixture('found').replaceAll('Cape Town facility', 'East London facility');
    expect(stages(elsewhere).slice(2, 5)).toEqual(['Loaded for delivery from East London facility out_for_delivery',
      'Dispatched in_transit', 'Loaded on manifest to East London facility in_transit']);
  });
  it('answers a waybill whose scans are all hidden as one without history', () => {
    const reply = JSON.parse(fixture('found'));
    for (const row of reply.results) row.hidden = '1';
    expect(() => parseTracking(JSON.stringify(reply), 'WB7058138', 200)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });
  it('rejects a different identity', () => {
    expect(() => parseTracking(fixture('found'), 'ZZZ999990', 200)).toThrow();
  });
  it('recognizes the observed absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), 'ZZZ999990', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });
  it('keeps an unavailable endpoint distinct from an unknown shipment', () => {
    expect(() => parseTracking('<html>Unavailable</html>', 'WB7058138', 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('rejects a changed response', () => {
    expect(() => parseTracking('<html></html>', 'WB7058138', 200)).toThrow();
  });
});
