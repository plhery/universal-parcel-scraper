import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeWaybill, parseTracking } from './parser.js';

const summary = readFileSync(new URL('./fixtures/delivered-summary.json', import.meta.url), 'utf8');
const activity = readFileSync(new URL('./fixtures/delivered-activity.json', import.meta.url), 'utf8');
const waybill = '60376070212';
const token = 'guest.session.token';
const login = JSON.stringify({ data: { loginAsAnonymousUser: { security: { id_token: token, exp: 1 } } } });
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it('opens a guest session on the SriLankan portal and reads the waybill on station clocks', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(login))
    .mockImplementation(async (_url, init) => new Response(String(init?.body).includes('GetShipmentsByAwbs(') ? summary : activity));
  const result = await tracker(fetcher).track({ number: '603-7607 0212' });

  expect(fetcher).toHaveBeenCalledTimes(3);
  const [url, signIn] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://srilankancargo.ibsplc.aero/portalgateway/graphql');
  expect(new Headers(signIn?.headers).get('Origin')).toBe('https://srilankancargo.ibsplc.aero');
  for (const [, request] of fetcher.mock.calls.slice(1)) {
    expect(new Headers(request?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(String(request?.body)).toContain(waybill);
  }
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2025-02-07T17:35:00',
  });
  expect(result.events?.at(-1)).toMatchObject({
    description: 'Booked for UL0196', location: 'DEL', local_time: '2025-02-03T11:39:48', stage: 'registered',
  });
});

it('counts each flight arrival once and keeps the stage before a booking made after the departure', () => {
  const { events = [] } = parseTracking(summary, activity, waybill);
  expect(events.map(event => event.provider_code)).toEqual(
    ['DLV', 'BKD', 'NFD', 'RCF', 'ARR', 'BKD', 'DEP', 'MAN', 'PRE', 'FOH', 'RCS', 'BKD', 'BKD', 'BKD'],
  );
  expect(events.slice(1, 5)).toEqual([
    expect.not.objectContaining({ stage: expect.anything() }),
    expect.objectContaining({ description: 'Consignee notified for UL0192', location: 'CMB', stage: 'ready_for_pickup' }),
    expect.objectContaining({ description: 'Broken down from UL0192', stage: 'in_transit' }),
    expect.objectContaining({ description: 'Arrived on UL0192', local_time: '2025-02-04T08:51:00' }),
  ]);
  expect(events.find(event => event.provider_code === 'DEP')).toMatchObject({ description: 'Departed on UL0192', location: 'DEL' });
  expect(events.find(event => event.provider_code === 'PRE')).not.toHaveProperty('stage');
});

it('answers an unknown waybill as not found and another waybill as indeterminate', () => {
  const empty = JSON.stringify({ data: { GetShipmentsByAwbs: [] } });
  const none = JSON.stringify({ data: { GetShipmentActivityByAwb: { items: [] } } });
  expect(() => parseTracking(empty, none, '60399999992')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(summary, activity, '60399999992')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('accepts a 603 waybill or its serial when the check digit holds', () => {
  expect(normalizeWaybill('603 7607 0212')).toBe(waybill);
  expect(normalizeWaybill('76070212')).toBe(waybill);
  expect(() => normalizeWaybill('603-76070213')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  expect(() => normalizeWaybill('297-76070212')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
});
