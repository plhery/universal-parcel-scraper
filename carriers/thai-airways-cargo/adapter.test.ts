import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const sin = readFileSync(new URL('./fixtures/delivered-sin.html', import.meta.url), 'utf8');
const sgn = readFileSync(new URL('./fixtures/delivered-sgn.html', import.meta.url), 'utf8');
const form = `<form name="Form1" action="/skychain/app" method="post">
  <input type="hidden" name="Form1" value="public form state">
  <input type="hidden" name="trackForm_hdnLastPermissionCheck" value="">
  <input type="hidden" name="trackForm_hdnLastPermissionCode" value="">
  <input name="txtPrefix" value="217"><input name="txtNumber">
  <input type="submit" name="$JSubmit$0" value="Track">
</form>`;

it('submits the current anonymous form and reads the matching detailed history', async () => {
  const landing = new Response(form, { headers: { 'Set-Cookie': 'guest=session; Path=/' } });
  Object.defineProperty(landing, 'url', { value: 'https://chorus.thaicargo.com/skychain/app' });
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(landing)
    .mockResolvedValueOnce(new Response(sin));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('thai-airways-cargo', '217-09058722') });

  expect(fetcher).toHaveBeenCalledTimes(2);
  const [url, request] = fetcher.mock.calls[1]!;
  expect(String(url)).toBe('https://chorus.thaicargo.com/skychain/app');
  expect(request?.method).toBe('POST');
  expect(new Headers(request?.headers).get('Cookie')).toBe('guest=session');
  expect(Object.fromEntries(request?.body as URLSearchParams)).toMatchObject({
    Form1: 'public form state', txtPrefix: '217', txtNumber: '09058722', '$JSubmit$0': 'Track',
    trackForm_hdnLastPermissionCheck: 'Y', trackForm_hdnLastPermissionCode: '',
  });
  expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-05-18T05:20' });
  expect(result.events?.[0]).toMatchObject({ description: 'Delivered', stage: 'delivered', location: 'SIN' });
  expect(result.events?.find(event => event.local_time === '2026-05-16T05:21')).toMatchObject({
    description: 'Delivered', stage: 'in_transit', location: 'SIN',
  });
  expect(result.events?.at(-1)).toMatchObject({ description: 'Received from Shipper', stage: 'accepted', location: 'DEL' });
  expect(result.events?.some(event => event.time)).toBe(false);
});

it('keeps a partial delivery in transit when the remaining piece is unrecorded', () => {
  const page = load(sgn);
  const result = parseTracking(page, '217-04563042');
  expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2025-07-02T13:55' });
  page('#trackShiptable1rowInner0 table.grdTable tr.grdRow').first().remove();
  expect(parseTracking(page, '217-04563042')).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'Delivered', last_update_local: '2025-07-02T13:54',
  });
});

it('requires the requested waybill in the result', () => {
  expect(() => parseTracking(load(sin), '217-04563042')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('stops before submitting when the landing page requires verification', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<title>Access Denied</title>', { status: 403 }));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: '09058722' })).rejects.toMatchObject({ kind: 'challenge' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
