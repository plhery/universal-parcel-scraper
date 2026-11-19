import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');

describe('Velocity Express tracking', () => {
  it('reads the public shipment with its latest carrier clock', () => {
    const result = parseTracking(fixture('found'), 'VIN0392703', 200);
    expect(result.current_stage).toBe('delivered');
    expect(result.last_update_local).toBe('2026-11-04T18:08:26');
    expect(result.events).toHaveLength(13);
  });

  it('words a remark that names the signer by its status instead', () => {
    const reply = JSON.parse(fixture('found'));
    const number: string = reply[0].Parent[0].AirwayBill;
    const delivered = reply[0].Child.find((row: { Statuscode: string }) => row.Statuscode === 'SPD');
    delivered.Remarks = 'Delivered, signed by A Neighbour';
    const result = parseTracking(JSON.stringify(reply), number, 200);
    expect(result.events![0]).toMatchObject({ description: 'Delivered', provider_code: 'SPD', stage: 'delivered' });
    expect(JSON.stringify(result)).not.toContain('Neighbour');
  });

  it('rejects a result for another shipment', () => {
    expect(() => parseTracking(fixture('found'), 'VIN0000000', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes the carrier\'s explicit absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), 'VIN0000000', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('treats an unavailable route as a tracking failure', () => {
    expect(() => parseTracking('<html>Unavailable</html>', 'VIN0000000', 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
