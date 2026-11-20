import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseBill, parseMovements } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const bill = fixture('bill');
const movements = fixture('movements');
const missing = fixture('missing');
const number = numbers.records[0]!.number;
const unprefixed = number.slice(4);
const container = 'EGHU3430760';
const unknown = '012345678900';

describe('Evergreen Line', () => {
  it('submits the bill, then the movement form for its container', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(bill))
      .mockImplementationOnce(async () => new Response(movements));
    const tracker = adapter({ fetcher, userAgent: 'Evergreen fixture/1.0', recorder: NOOP_RECORDER,
      env: {}, trawl: null, browserExecutablePath: null });

    const result = await tracker.track({ number });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [lookup, detail] = fetcher.mock.calls;
    expect(lookup?.[0]).toBe('https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do');
    expect(lookup?.[1]).toMatchObject({ method: 'POST', headers: { 'User-Agent': 'Evergreen fixture/1.0' } });
    expect((lookup?.[1]?.body as URLSearchParams).get('BL')).toBe(unprefixed);
    expect(Object.fromEntries(detail?.[1]?.body as URLSearchParams)).toMatchObject({
      TYPE: 'CntrMove', bl_no: unprefixed, cntr_no: container, onboard_date: '20260913', pol: 'CNYYT', pod: 'USBOS',
    });
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered',
      last_status_text: 'Empty container returned', last_update_local: '2026-11-06',
    });
    expect(result.events).toHaveLength(8);
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result.events?.[1]).toMatchObject({
      local_time: '2026-11-05', description: 'Pick-up by merchant haulage', location: 'BOSTON, MA (US)', stage: 'delivered',
    });
    expect(result.events?.[6]).toMatchObject({ local_time: '2026-09-07', stage: 'accepted' });
    expect(result.events?.every(event => event.time === undefined)).toBe(true);
  });

  it('binds absence, the bill and its movements to their respective identifiers', () => {
    expect(() => parseBill(missing, unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBill(missing, unprefixed)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBill(bill, unknown)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMovements(movements, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps verification and a changed movement row distinct from an absent bill', () => {
    expect(() => parseBill('<title>Security Check</title>', unknown)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseMovements(movements.replace('NOV-06-2026', 'NOV-31-2026'), container))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
