import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const [ningbo, qingdao, koper, equipment] = numbers.records;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('looks up an exact bill and combines repeated scans across its containers', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('ningbo-to-chattogram')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('tailwind-shipping-lines', ningbo!.number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://tailwind-ecom-proxy.api.prod.sit.sys.odj.cloud/api/v2/tracking/' + ningbo!.number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'Loaded on vessel', last_update: '2026-11-10T23:34:00+08:00',
  });
  expect(result.events).toHaveLength(13);
  expect(result.events?.[0]).toMatchObject({ location: 'PORT KLANG', provider_code: 'LoadTranshipmentFull' });
  expect(result.events?.filter(scan => scan.provider_code === 'LoadFull')).toHaveLength(1);
  expect(result.events?.some(scan => scan.location === 'CHATTOGRAM')).toBe(false);
});

it('leaves estimated scans out even when their planned date has passed', () => {
  const result = parseTracking(JSON.parse(fixture('qingdao-to-chattogram')), qingdao!.number);
  expect(result).toMatchObject({ status: 'pending', last_status_text: 'Sent to shipper' });
  expect(result.events?.map(scan => scan.provider_code)).toEqual(Array(4).fill('SentToShipper'));

  const transit = parseTracking(JSON.parse(fixture('koper-to-port-klang')), koper!.number);
  expect(transit.events).toHaveLength(16);
  expect(transit.events?.[0]).toMatchObject({
    time: '2026-11-18T07:32:00+08:00', description: 'Discharged full', location: 'PORT KLANG',
  });
  expect(transit.events?.at(-1)?.time).toBe('2026-10-12T21:18:00+01:00');
});

it('limits equipment lookups to the exact selected container', () => {
  const booking: unknown = JSON.parse(fixture('ningbo-to-chattogram'));
  expect(parseTracking(booking, 'TAWU4003508').events).toHaveLength(5);
  expect(() => parseTracking(booking, koper!.number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(booking, equipment!.number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(parseTracking(JSON.parse(fixture('container')), equipment!.number)).toMatchObject({
    last_update: '2026-11-14T00:00:00+08:00', current_stage: 'in_transit',
  });
});
