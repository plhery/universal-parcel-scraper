import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { indigoPortal, parseTracking } from './parser.js';

const delivered = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const departed = readFileSync(new URL('./fixtures/departed.html', import.meta.url), 'utf8');

it('shows the dated delivery and preserves repeated manifest notices and station clocks', () => {
  const result = parseTracking(delivered, '31296403812');
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered at LHR',
    last_update: null, last_update_local: '2026-02-08T09:25:15', weight_kg: 1461,
  });
  expect(result.events?.map(event => [event.description, event.location])).toEqual([
    ['Delivered', 'LHR'], ['Arrived', 'LHR'], ['Departed', 'BOM'], ['Manifested', 'BOM'],
    ['Manifested', 'BOM'], ['Accepted', 'BOM'], ['Booked', 'BOM'],
  ]);
});

it('keeps a departure in transit and rejects a different returned master waybill', () => {
  expect(parseTracking(departed, '31296361646')).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'Departed at BOM', weight_kg: 12.7,
  });
  expect(() => parseTracking(departed, '31296403812')).toThrow(IndeterminateError);
});

it('routes a valid IndiGo waybill to IndiGo and rejects another airline before any request', async () => {
  const form = `<form id="FrmAWBTracking" method="post" action="./FrmAWBTracking.aspx">
    <input type="hidden" name="__VIEWSTATE" value="guest-state" />
    <input id="txtPrefix" /><textarea id="TextBoxAWBno"></textarea><input id="ButtonGO" />
  </form>`;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(form))
    .mockResolvedValueOnce(new Response(delivered));
  const instance = adapter({ fetcher, userAgent: 'IndiGo test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: '51650024855' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(instance.track({ number: '312-96403812' })).resolves.toMatchObject({ current_stage: 'delivered' });
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([indigoPortal.tracker, indigoPortal.tracker]);
  const init = fetcher.mock.calls[1]![1];
  expect(new Headers(init?.headers).get('User-Agent')).toBe('IndiGo test agent');
  expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({
    txtPrefix: '312', TextBoxAWBno: '96403812', __VIEWSTATE: 'guest-state',
  });
});
