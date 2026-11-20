import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseBill, parseMovements } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const bill = fixture('bill');
const movements = fixture('movements');
const missing = fixture('missing');
const number = numbers.records[0]!.number;
const unprefixed = number.slice(4);
const movementId = 'CSEL6720797880';

it('submits the whole bill and reads the returned container movements', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(bill))
    .mockImplementationOnce(async () => new Response(movements));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [lookup, detail] = fetcher.mock.calls;
  expect(lookup?.[0]).toBe('https://esvc.smlines.com/smline/CUP_HOM_3301GS.do');
  expect(lookup?.[1]?.method).toBe('POST');
  expect(Object.fromEntries(lookup?.[1]?.body as URLSearchParams))
    .toMatchObject({ f_cmd: '121', search_type: 'B', search_name: unprefixed });
  expect(Object.fromEntries(detail?.[1]?.body as URLSearchParams))
    .toMatchObject({ f_cmd: '125', cntr_no: 'SMCU1140862', bkg_no: unprefixed, cop_no: movementId });
  expect(result).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Empty Container Returned from Customer',
    last_update_local: '2026-09-16T18:53',
  });
  expect(result.events).toHaveLength(10);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).toMatchObject({ local_time: '2026-09-14T10:19', location: 'LONG BEACH, CA, UNITED STATES', stage: 'in_transit' });
  expect(result.events?.[8]).toMatchObject({ provider_code: 'FOTMAD', stage: 'accepted' });
  expect(result.events?.every(event => event.time === undefined)).toBe(true);
});

it('distinguishes absence, unbound data, and a failed query', () => {
  expect(() => parseBill(missing, 'PUS123456789')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseBill(bill, 'PUS123456789')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseMovements(movements, 'OTHER')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseBill(missing.replace('"S"', '"F"'), unprefixed)).toThrow(expect.objectContaining({ kind: 'schema' }));
});

it('omits estimated movements and rejects invalid actual dates', () => {
  const withEstimate = movements.replace('"actTpCd": "A"', '"actTpCd": "E"');
  expect(parseMovements(withEstimate, movementId).events).toHaveLength(9);
  expect(() => parseMovements(movements.replace('2026-08-25', '2026-08-32'), movementId))
    .toThrow(expect.objectContaining({ kind: 'schema' }));
});
