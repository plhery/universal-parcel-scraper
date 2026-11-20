import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const serial = number.slice(4);
const fixture = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
const history = fixture('history.json');

it('looks up the exact master air waybill with the public page context', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(fixture('landing.html')))
    .mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://www.qrcargo.com/s/track-your-shipment');
  expect(fetcher.mock.calls[1]?.[0]).toBe('https://www.qrcargo.com/s/sfsites/aura');
  const request = fetcher.mock.calls[1]?.[1];
  expect(request?.method).toBe('POST');
  expect(request?.body).toBeInstanceOf(URLSearchParams);
  const body = request?.body as URLSearchParams;
  expect(body.get('aura.token')).toBe('null');
  expect(JSON.parse(body.get('aura.context')!)).toMatchObject({ mode: 'PROD', app: 'siteforce:communityApp' });
  expect(JSON.parse(body.get('message')!)).toMatchObject({ actions: [{
    params: { method: 'QCG_getAwbDetailsMS', params: {
      awbs: [{ documentType: 'MAWB', documentPrefix: '157', documentNumber: serial }],
    } },
  }] });
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Notified consignee', last_update_local: '2023-01-26T02:25' });
  expect(result.events).toHaveLength(9);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'NFD', location: 'NBO', stage: 'in_transit' });
  expect(result.events?.at(-1)).toMatchObject({ provider_code: 'RCS', location: 'CDG', stage: 'accepted' });
});

it('rejects empty results and a different air waybill', () => {
  expect(() => parseTracking(fixture('missing.json'), '00000001')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, '00000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
