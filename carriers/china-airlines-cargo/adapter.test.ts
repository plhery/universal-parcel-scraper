import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeWaybill, parseTracking } from './parser.js';

const summary = readFileSync(new URL('./fixtures/delivered-summary.json', import.meta.url), 'utf8');
const activity = readFileSync(new URL('./fixtures/delivered-activity.json', import.meta.url), 'utf8');
const waybill = '29772328572';
const token = 'guest.session.token';
const login = JSON.stringify({ data: { loginAsAnonymousUser: { security: { id_token: token, exp: 1 } } } });
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

function withSummary(edit: (shipment: Record<string, unknown>) => void): string {
  const reply = JSON.parse(summary) as { data: { GetShipmentsByAwbs: Record<string, unknown>[] } };
  edit(reply.data.GetShipmentsByAwbs[0]!);
  return JSON.stringify(reply);
}

function withoutRows(drop: (row: { event: string }) => boolean): string {
  const reply = JSON.parse(activity) as { data: { GetShipmentActivityByAwb: { items: { event: string }[] } } };
  reply.data.GetShipmentActivityByAwb.items = reply.data.GetShipmentActivityByAwb.items.filter(row => !drop(row));
  return JSON.stringify(reply);
}

it('opens a guest session and reads the waybill with its activity on station clocks', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(login))
    .mockImplementation(async (_url, init) => new Response(String(init?.body).includes('GetShipmentsByAwbs(') ? summary : activity));
  const result = await tracker(fetcher).track({ number: '297-72328572' });

  expect(fetcher).toHaveBeenCalledTimes(3);
  const [url, signIn] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://icargowebportal.china-airlines.com/portalgateway/graphql');
  expect(JSON.parse(String(signIn?.body))).toMatchObject({ operationName: 'loginAsAnonymousUser' });
  for (const [, request] of fetcher.mock.calls.slice(1)) {
    expect(new Headers(request?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(request?.body)).variables).toMatchObject(
      expect.objectContaining(String(request?.body).includes('shipmentNumbers') ? { shipmentNumbers: [waybill] } : { shipmentNumber: waybill }),
    );
  }
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-03-16T18:08:00',
  });
  expect(result.events?.[0]).toMatchObject({ provider_code: 'DLV', location: 'KUL', stage: 'delivered' });
  expect(result.events?.at(-1)).toMatchObject({ description: 'Booked for CI5239, CI0721', location: 'ORD', local_time: '2026-03-11T10:36:15' });
  expect(result.events?.some(event => event.time)).toBe(false);
});

it('keeps the carrier order, counts each flight arrival once and merges rows of one minute', () => {
  const { events = [] } = parseTracking(summary, activity, waybill);
  expect(events.slice(0, 4)).toEqual([
    expect.objectContaining({ description: 'Delivered', local_time: '2026-03-16T18:08:00' }),
    expect.objectContaining({ description: 'Broken down from CI0721', local_time: '2026-03-16T14:16:00', stage: 'in_transit' }),
    expect.objectContaining({ description: 'Arrived on CI0721', local_time: '2026-03-16T13:22:00', location: 'KUL' }),
    expect.objectContaining({ description: 'Booked for CI5239, CI0721', local_time: '2026-03-16T08:39:21', location: 'TPE' }),
  ]);
  expect(events.filter(event => event.description === 'Arrived on CI5239')).toHaveLength(1);
  expect(events.find(event => event.provider_code === 'DEP' && event.location === 'ORD')).toMatchObject({
    description: 'Departed on CI5239', local_time: '2026-03-14T07:23:01', stage: 'in_transit',
  });
  expect(events.find(event => event.provider_code === 'MAN')).not.toHaveProperty('stage');
  expect(events.find(event => event.provider_code === 'RCS')).toMatchObject({ description: 'Accepted', stage: 'accepted' });
});

it('keeps a delivery of some pieces in transit until the tracker completes the waybill', () => {
  const open = withSummary(shipment => {
    shipment.milestones = [{ milestone: 'ACCEPTED', status: 'done' }, { milestone: 'DELIVERED', status: 'to do' }];
  });
  expect(parseTracking(open, activity, waybill)).toMatchObject({ current_stage: 'delivered' });
  const partial = JSON.parse(activity) as { data: { GetShipmentActivityByAwb: { items: { event: string; pieces: number }[] } } };
  partial.data.GetShipmentActivityByAwb.items[0]!.pieces = 9;
  expect(parseTracking(open, JSON.stringify(partial), waybill)).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'Delivered',
  });
});

it('reads a shipment still on its way by its newest staged activity', () => {
  const result = parseTracking(withSummary(shipment => {
    shipment.milestones = [{ milestone: 'DELIVERED', status: 'to do' }];
  }), withoutRows(row => row.event === 'DLV' || row.event === 'RCF' || row.event === 'ARR'), waybill);
  expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Booked for CI5239, CI0721' });
  // A booking after the goods moved keeps the stage before it; the first booking registers the waybill.
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.at(-1)).toMatchObject({ provider_code: 'BKD', stage: 'registered' });
});

it('answers an unknown waybill as not found and another waybill as indeterminate', () => {
  const empty = JSON.stringify({ data: { GetShipmentsByAwbs: [] } });
  const none = JSON.stringify({ data: { GetShipmentActivityByAwb: { items: [] } } });
  expect(() => parseTracking(empty, none, '29712345670')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(summary, activity, '29712345670')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(empty, activity, waybill)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('reports a refused query and a blocked page as such, not as a missing shipment', async () => {
  const refused = JSON.stringify({ errors: [{ error_code: 'admin.user.notloggedIn' }] });
  expect(() => parseTracking(refused, activity, waybill)).toThrow(expect.objectContaining({ kind: 'schema' }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html><title>Access Denied</title></html>', { status: 403 }));
  await expect(tracker(fetcher).track({ number: waybill })).rejects.toMatchObject({ kind: 'challenge' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('accepts a 297 waybill or its serial when the check digit holds', () => {
  expect(normalizeWaybill('297 7232 8572')).toBe(waybill);
  expect(normalizeWaybill('72328572')).toBe(waybill);
  expect(() => normalizeWaybill('297-72328573')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  expect(() => normalizeWaybill('157-72328572')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
});
