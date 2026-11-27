import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording, statusGapNote } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseDispatchTrack } from '../high-energy-transport/dispatchtrack.js';
import { adapter, RYDER_LAST_MILE } from './adapter.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's snapshot and order widget, with the recipient, the address, the phones, the driver, the truck, the
// items and the live channel left out. The snapshot labels the order with DispatchTrack's own number; the widget gives
// the sample's number as the order's reference.
const SAMPLE = '1000672514';
const ORDER = '2470087001';
const OTHER = 'ZZ9000001';

type Widget = { service_orders: Record<string, unknown>[] } & Record<string, unknown>;
const fixture = <T = Record<string, unknown>>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const snapshot = (changes: Record<string, unknown> = {}) => ({ ...fixture(`snapshot-${SAMPLE}`), ...changes });
const widget = (changes: Record<string, unknown> = {}) => {
  const reply = fixture<Widget>(`widget-${SAMPLE}`);
  return { ...reply, service_orders: [{ ...reply.service_orders[0], ...changes }] };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replies = (...bodies: (() => Response)[]) => bodies.reduce((mock, body) => mock.mockImplementationOnce(async () => body()), vi.fn<typeof fetch>());

describe('Ryder Last Mile tracking adapter', () => {
  it('asks the snapshot, then the order widget for the order’s events, without a ZIP code', async () => {
    const fetcher = replies(() => json(snapshot()), () => json(widget()));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered', delivered_at: '2022-12-30T17:23:32-05:00' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://mxd.dispatchtrack.com/api/v1/order_tracker/6b8db72?phone_number=1000672514',
      'https://mxd.dispatchtrack.com/track_orders/6b8db72/1000672514',
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    }
    expect(carrier(fetcher)).toMatchObject({ id: 'ryder-last-mile', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the snapshot’s not-found answer as not found, without asking the widget', async () => {
    const fetcher = replies(() => json(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a widget that disagrees, refuses or is checked apart from a missing order', async () => {
    const answer = (body: () => Response) => carrier(replies(() => json(snapshot()), body)).track({ number: SAMPLE }, { budgetMs: 2000 })
      .catch((error: unknown) => error);
    expect(await answer(() => json(fixture('widget-not-found')))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ captcha_error: true }, { status: 422 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({}, { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('<title>Track Order</title>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ ...widget(), business: { track_code: 'f7ea831' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Ryder Last Mile replies', () => {
  it('reads the public sample: the widget’s events, newest first, at their stated offsets', () => {
    expect(parseDispatchTrack(RYDER_LAST_MILE, snapshot(), SAMPLE, widget())).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      provider_code: 'completed', last_update: '2022-12-30T17:23:32-05:00', expected_delivery: null, delivered_at: '2022-12-30T17:23:32-05:00',
      events: [
        { time: '2022-12-30T17:23:32-05:00', location: 'SAMMAMISH, WA', description: 'Order Delivered-Shipment Delivered on 12/30/22 between 16:08 and 16:11', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2022-12-30T12:55:19-05:00', location: 'KENT, WA', description: 'Order enroute to customer-Shipped from SEA on 12/30/22 07:00 (PST) on 0003816402', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2022-12-29T16:29:34-05:00', location: 'KENT, WA', description: 'Time Window notification attempted' },
        { time: '2022-12-29T16:07:13-05:00', location: 'KENT, WA', description: 'Time Window set-Appt set between 16:00 & 18:00 on 12/30/22- Dispatch Track' },
        { time: '2022-12-29T09:37:11-05:00', location: 'KENT, WA', description: 'Time Window set-Appt set between 18:30 & 20:30 on 12/30/22- Dispatch Track' },
        { time: '2022-12-27T18:53:24-05:00', location: 'KENT, WA', description: 'Delivery Scheduled-Scheduled for 12/30/22 - updated via EDI' },
        { time: '2022-12-27T18:40:30-05:00', location: 'KENT, WA', description: 'Scheduling Call - Attempt 1' },
        { time: '2022-12-27T17:15:15-05:00', location: 'KENT, WA', description: 'Order received at delivery location-Received at Ryder on 12/27/22 at 00:00 (PST) on VT3807175', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2022-12-27T17:14:58-05:00', location: 'NORCROSS, GA', description: 'Order departed-ETA set for SEA on 12/30/22 17:00 (PST) on VT3807175', stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
  });

  it('takes a scheduled order’s stage from its newest staged event, and its window from the snapshot', () => {
    const scheduled = snapshot({ stage: 'assigned', statusLabel: 'Scheduled', displayStatus: 'Delivery Scheduled' });
    const events = fixture<Widget>(`widget-${SAMPLE}`).service_orders[0]!.order_ship_events as unknown[];
    expect(parseDispatchTrack(RYDER_LAST_MILE, scheduled, SAMPLE, widget({ order_ship_events: events.slice(2) }))).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Delivery Scheduled',
      provider_code: 'assigned', last_update: '2022-12-29T16:29:34-05:00',
      expected_delivery_from: '2022-12-30T16:00:00-08:00', expected_delivery: '2022-12-30T18:00:00-08:00',
    });
    // Without staged events the snapshot's stage stands; without events the result is a summary.
    expect(parseDispatchTrack(RYDER_LAST_MILE, scheduled, SAMPLE, widget({ order_ship_events: [] })))
      .toMatchObject({ current_stage: 'registered', last_update: null, summary_only: true, events: [] });
  });

  it('binds the order by the snapshot’s label and the number asked', () => {
    // The widget finds the order by its own number too.
    expect(parseDispatchTrack(RYDER_LAST_MILE, snapshot(), ORDER, widget())).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseDispatchTrack(RYDER_LAST_MILE, snapshot(), OTHER, widget())).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDispatchTrack(RYDER_LAST_MILE, snapshot(), SAMPLE, widget({ service_order_number: 'ZZ9000002' })))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDispatchTrack(RYDER_LAST_MILE, snapshot(), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses an event without its time or wording', () => {
    const event = { event_datetime: '2022-12-30T17:23:32-05:00', event_location: 'KENT, WA', event_description: 'Order departed' };
    expect(() => parseDispatchTrack(RYDER_LAST_MILE, snapshot(), SAMPLE, widget({ order_ship_events: [{ ...event, event_datetime: '12/30/2022' }] })))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDispatchTrack(RYDER_LAST_MILE, snapshot(), SAMPLE, widget({ order_ship_events: [{ ...event, event_description: '' }] })))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDispatchTrack(RYDER_LAST_MILE, snapshot(), SAMPLE, widget({ order_ship_events: 'none' })))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Ryder Last Mile statuses', () => {
  it('maps each stage code and event it records, and leaves the appointment notices as gaps', () => {
    for (const entry of statuses.entries) {
      const code = ('code' in entry ? entry.code : null) ?? null;
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(code, wording), entry.wording).toBe(entry.stage ?? undefined);
      expect(statusMapAnswer({ carrier: 'ryder-last-mile', providerCode: code, description: entry.wording }), entry.wording)
        .toMatchObject(entry.stage ? { stage: entry.stage } : { kind: 'intentional_gap' });
      if (!entry.stage) expect(statusGapNote(statusMap, code, wording)).toBeDefined();
    }
    expect(statusMap.stage(null, 'order rescheduled-for 01/02/23')).toBeUndefined();
  });
});
