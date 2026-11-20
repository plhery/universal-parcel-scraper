import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseCount, parseMovements, trackingResult } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');
const mode = 'PROD';
const app = 'siteforce:communityApp';
const reference = encodeURIComponent(JSON.stringify({
  mode, app, fwuid: 'public-framework-id', loaded: { ['APPLICATION@markup://' + app]: 'public-application-id' },
}));
const landing = () => new Response('<script src="/crowley/s/sfsites/l/' + reference + '/bootstrap.js"></script>');
const trackerWith = (fetcher: typeof fetch) => adapter({
  fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null,
});

it('uses the guest form for the bill and returns six dated movements', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(landing())
    .mockResolvedValueOnce(new Response(fixture('found-count')))
    .mockResolvedValueOnce(new Response(fixture('found-history')));
  const result = await trackerWith(fetcher).track({ number: directTrackingNumber('crowley', number) });
  expect(fetcher).toHaveBeenCalledTimes(3);
  const request = fetcher.mock.calls[2]!;
  expect(request[0]).toBe('https://csight.crowley.com/crowley/s/sfsites/aura');
  const form = request[1]?.body as URLSearchParams;
  expect(form.get('aura.token')).toBe('null');
  expect(JSON.parse(form.get('message')!)).toMatchObject({
    actions: [{ params: {
      method: 'fetchProcessedEquipmentEventByContainerId',
      params: { parameter: { bolNumber: 'CWPN26201624', isNonLoginPortal: true, isLoginPortal: false } },
    } }],
  });
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Gate Out Full(GOF)', last_update_local: '2026-11-17T15:43:00' });
  expect(result.events).toHaveLength(6);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'GOF', location: 'Port Everglades, FL(USPEF)' });
});

it('retains equipment scans and only maps confirmed shipment stages', () => {
  const movements = parseMovements(fixture('caribbean-history'));
  const result = trackingResult([...movements, ...movements]);
  expect(result).toMatchObject({ status: 'in_transit', last_update_local: '2026-11-13T13:54:01' });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).toMatchObject({ provider_code: 'VUF', stage: 'in_transit' });
});

it('distinguishes the full movement count from the first page', () => {
  expect(parseCount(fixture('paginated-count'))).toBe(94);
  expect(parseMovements(fixture('paginated-first-page'))).toHaveLength(10);
});

it('stops after a genuine empty count', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(landing())
    .mockResolvedValueOnce(new Response(fixture('missing-count')));
  await expect(trackerWith(fetcher).track({ number: 'ZZZZ00000000' })).rejects.toMatchObject({ kind: 'not_found' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('stops immediately if the carrier returns a challenge response', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 403 }));
  await expect(trackerWith(fetcher).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
