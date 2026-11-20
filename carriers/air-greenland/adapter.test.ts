import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('published-example');
const outbound = JSON.parse(fixture('outbound'));
const split = JSON.parse(fixture('split-delivery'));

it('binds the published waybill and retains its yearless scans', () => {
  const result = parseTracking(JSON.parse(example), '63127774563');
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', weight_kg: 38, last_update: null,
    events: [
      { stage: 'in_transit', description: '4 pieces arrived on GL4427', location: 'NARSARSUAQ', provider_time_text: '25SEP' },
      { stage: 'delivered', description: '4 pieces delivered', location: 'NARSARSUAQ', provider_time_text: '28SEP' },
    ],
  });
  expect(result.events?.[0]?.time).toBeUndefined();
  expect(() => parseTracking(JSON.parse(example), '63127774564')).toThrow(IndeterminateError);
});

it('keeps distinct movements and treats the handling agent as an intermediate stop', () => {
  const result = parseTracking(outbound, '63128346986');
  expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'in_transit', 'delivered']);
  expect(result.events?.at(-1)).toMatchObject({ description: '3 pieces delivered', provider_time_text: '19JUL 11:24' });
  expect(JSON.stringify(result)).not.toContain('BLUE WATER');
  expect(parseTracking({ ...outbound, statusList: outbound.statusList.slice(0, 2) }, '63128346986').current_stage)
    .toBe('in_transit');
});

it('reports whole delivery only when all distinct groups of pieces were delivered', () => {
  const result = parseTracking(split, '63128353732');
  expect(result.current_stage).toBe('delivered');
  expect(result.events).toHaveLength(5);
  expect(result.events?.at(-1)).toMatchObject({ stage: 'in_transit', provider_time_text: '09MAY', location: 'COPENHAGEN' });
  const partial = parseTracking({ ...split, statusList: split.statusList.slice(0, 3) }, '63128353732');
  expect(partial.current_stage).toBe('in_transit');
  expect(partial.events?.at(-1)).toMatchObject({ description: '1 piece delivered', stage: 'in_transit' });
});

it('distinguishes the site’s negative response, an empty history, and changing schema', () => {
  expect(() => parseTracking({ queryOkay: false, awbNo: null, statusList: null }, '63127774563')).toThrow(NotFoundError);
  expect(() => parseTracking({ queryOkay: false }, '63127774563')).toThrow(SchemaError);
  expect(() => parseTracking({ ...split, statusList: [] }, '63128353732')).toThrow(NoHistoryError);
  expect(() => parseTracking({ ...split, statusList: [7] }, '63128353732')).toThrow(SchemaError);
});

it('passes the normalized waybill and English language to the native guest lookup', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
  const instance = adapter({ fetcher, userAgent: 'Air Greenland test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: ' 631-27774563 ' })).resolves.toMatchObject({ status: 'delivered' });
  await expect(instance.track({ number: '51650024855' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [request, init] = fetcher.mock.calls[0]!;
  expect(String(request)).toBe('https://airgreenland.com/umbraco/api/Calculator/track?awbNumber=63127774563&cargoLanguageId=en&action=get');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(init?.headers).get('User-Agent')).toBe('Air Greenland test agent');
  fetcher.mockResolvedValueOnce(new Response('<title>Just a moment</title>'));
  await expect(instance.track({ number: '63127774563' })).rejects.toThrow(ChallengeError);
});
