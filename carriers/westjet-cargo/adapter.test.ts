import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const reference = '83811594284';

it('reads booking and movement scans with the correct event clocks', () => {
  const result = parseTracking(delivered, reference);
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered at YYZ', weight_kg: 29.5,
    last_update: null, last_update_local: '2025-09-04T11:50:00',
  });
  expect(result.events?.map(event => event.description)).toEqual(['Delivered', 'Arrived', 'Departed', 'Accepted', 'Booked']);
  expect(result.events?.[1]).toMatchObject({ local_time: '2025-09-03T23:31:00', location: 'YYZ' });
  expect(result.events?.[2]).toMatchObject({ local_time: '2025-09-03T14:45:00', location: 'YVR' });
  expect(result.events?.[0]?.time).toBeUndefined();
});

it('requires a whole returned air waybill or the exact negative echo', () => {
  expect(() => parseTracking(delivered, '83811594285')).toThrow(IndeterminateError);
  expect(() => parseTracking(fixture('not-found'), '83800000000')).toThrow(NotFoundError);
  expect(() => parseTracking(fixture('not-found'), reference)).toThrow(SchemaError);
  expect(() => parseTracking(delivered.replace('Event DateTime(LT)', 'Flight time'), reference)).toThrow(SchemaError);
  expect(() => parseTracking('<title>Just a moment</title>', reference)).toThrow(ChallengeError);
});

it('uses the guest result route and validates the carrier prefix and checksum', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(delivered));
  const instance = adapter({ fetcher, userAgent: 'WestJet Cargo test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: ' 838-11594284 ' })).resolves.toMatchObject({ current_stage: 'delivered' });
  await expect(instance.track({ number: '83811594285' })).rejects.toThrow(InvalidInputError);
  await expect(instance.track({ number: '51650024855' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://westjet.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix=838&AWBNo=11594284');
  expect(new Headers(init?.headers).get('User-Agent')).toBe('WestJet Cargo test agent');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

it('follows one carrier result redirect and rejects a different destination', async () => {
  const result = 'https://westjet.smartkargo.com/FrmAWBTracking.aspx?encrpt=1&AWBPrefix=demo-prefix&AWBNo=demo-waybill';
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: result } }))
    .mockResolvedValueOnce(new Response(delivered))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }));
  const instance = adapter({ fetcher, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: reference })).resolves.toMatchObject({ current_stage: 'delivered' });
  await expect(instance.track({ number: reference })).rejects.toThrow(SchemaError);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(String(fetcher.mock.calls[1]![0])).toBe(result);
});
