import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const html = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');

it('tracks the published Volaris waybill and keeps airport activity in reverse order', async () => {
  const portal = 'https://volarisy4.smartkargo.com/FrmAWBTracking.aspx';
  const continuation = portal + '?encrpt=0&AWBPrefix=036&AWBNo=18709025';
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: continuation } }))
    .mockResolvedValueOnce(new Response(html));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('volaris-cargo', '036-18709025') });

  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    'https://volarisy4.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix=036&AWBNo=18709025',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(fetcher).toHaveBeenNthCalledWith(2, continuation, expect.objectContaining({ redirect: 'manual' }));
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered at MID', last_update_local: '2021-03-24T09:07',
  });
  expect(result.events?.map(event => [event.description, event.local_time, event.location])).toEqual([
    ['Delivered', '2021-03-24T09:07', 'MID'],
    ['Arrived', '2021-03-24T07:50', 'MID'],
    ['Departed', '2021-03-24T06:00', 'MEX'],
    ['Manifested', '2021-03-24T06:00', 'MEX'],
    ['Arrived', '2021-03-23T23:30', 'MEX'],
    ['Departed', '2021-03-23T19:07', 'TIJ'],
    ['Manifested', '2021-03-23T19:07', 'TIJ'],
  ]);
  expect(result.events?.some(event => event.time)).toBe(false);
});

it('requires the result heading to match the requested waybill', () => {
  expect(() => parseTracking(html.replace('036-18709025', ''), '03618709025')).toThrow(
    expect.objectContaining({ kind: 'indeterminate' }),
  );
});

it('stops on forbidden responses', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 403 }));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: '18709025' })).rejects.toMatchObject({ kind: 'challenge' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects tracking redirects to another host without following them', async () => {
  const response = new Response(null, { status: 302, headers: { Location: 'https://example.org/FrmAWBTracking.aspx' } });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: '18709025' })).rejects.toMatchObject({ kind: 'transport' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
