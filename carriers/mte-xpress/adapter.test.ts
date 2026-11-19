import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseMteXpress } from './parser.js';

const found: { shipments: Record<string, unknown>[] } = JSON.parse(readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8'));
const number = 'UAMTDR3FB';

describe('MTE Xpress', () => {
  it('reads the shipment-level scans and retains the stated clock', () => {
    const result = parseMteXpress(found, number);
    expect(result.events).toHaveLength(10);
    expect(result.current_stage).toBe('delivered');
    expect(result.delivered_at).toBe('2026-04-10T09:52:18.882Z');
    // The delivery driver collects the parcel at the hub after the transit scans: that leg moves it on.
    expect(result.events!.map(event => `${event.provider_code} ${event.stage}`)).toEqual([
      'delivered delivered', 'out-for-delivery out_for_delivery', 'out-for-delivery out_for_delivery', 'collected in_transit',
      'collection-assigned in_transit', 'in-transit in_transit', 'at-hub in_transit', 'collected accepted',
      'collection-assigned registered', 'submitted registered',
    ]);
  });

  it('reads Ship Logic codes as Internet Express does, and leaves out the operational events the portal hides', () => {
    const shipment = found.shipments[0]!;
    const latest = { parcel_id: 0, date: '2026-04-10T12:00:00Z' };
    const rows = [{ ...latest, status: 'delivery-failed-attempt' }, { ...latest, date: '2026-04-10T12:30:00Z', status: 'on-hold-internal' },
      ...(shipment.tracking_events as unknown[])];
    const result = parseMteXpress({ shipments: [{ ...shipment, status: 'on-hold-internal', tracking_events: rows }] }, number);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Delivery failed attempt' });
    expect(result.events?.[0]).toMatchObject({ description: 'Delivery failed attempt', provider_code: 'delivery-failed-attempt', stage: 'failed_attempt' });
    expect(result.events).toHaveLength(11);
  });

  it('requires both the whole reference and the correct tenant', () => {
    expect(() => parseMteXpress(found, 'ZZZZZZZZZ')).toThrow();
    const other = { shipments: [{ ...found.shipments[0], provider_id: 9 }] };
    expect(() => parseMteXpress(other, number)).toThrow();
  });

  it('distinguishes the reference-bound negative from a generic 404', async () => {
    const track = (body: string) => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {},
      fetcher: async () => new Response(body, { status: 404 }) }).track({ number: 'ZZZZZZZZZ' });
    await expect(track('could not find shipment or parcel with reference ZZZZZZZZZ')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(track('page not found')).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
