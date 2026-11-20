import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { TheDeliveryGroupTracker } from './adapter.js';
import { normalizeTdgNumber, parseTdg, TDG_TRACKING_URL } from './parser.js';
import { RELAYED_DELAY, tdgStage, tdgWording } from './status.js';

const NUMBER = 'TDG000000000001', OTHER = 'TDG000000000002';
interface EventRow { EventDate: string; EventTime: string; Description: string; Location: string | null; OriginalEventMessage: string | null }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as {
  success: boolean; trackingResults: { TrackedShipment: {
    Carrier: string; CarrierShipmentReference: string; ClientShipmentReference: string; IsTrackingAvailable: boolean;
    Items: { CarrierItemReference: string; ClientitemReference: string; ItemEvents: EventRow[] }[];
  } };
};
const parse = (data: unknown = fixture, number = NUMBER) => parseTdg(JSON.stringify(data), number);

describe('The Delivery Group guest item history', () => {
  it('binds TDG ownership and one whole item, preserving all native local milestones', () => {
    const result = parse();
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-09-30T09:26:00', expected_delivery: null });
    expect(result.events).toHaveLength(10);
    expect(result.events?.[0]).toMatchObject({ time: '2026-09-30T09:26:00', description: 'Delivered', stage: 'delivered' });
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC RECIPIENT|SYNTHETIC ADDRESS|SYNTHETIC POD|Synthetic relay note|EffectiveFromUtc|08:26:00Z/);
  });

  it('reads the explicit partner delay instead of the relay’s generic delivery-attempt template', () => {
    expect(tdgWording('Delivery Issue', RELAYED_DELAY)).toBe(RELAYED_DELAY);
    expect(tdgStage(RELAYED_DELAY)).toBe('in_transit');
    expect(tdgStage('Delivery Issue')).toBeUndefined();
    expect(parse().events?.find(event => event.description === RELAYED_DELAY)).toMatchObject({ code: 'Delivery Issue', stage: 'in_transit' });
    const unknown = structuredClone(fixture);
    unknown.trackingResults.TrackedShipment.Items[0]!.ItemEvents[6]!.OriginalEventMessage = 'Synthetic new problem';
    expect(() => parse(unknown)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not confirm another network or merge multiple parcels under one reference', () => {
    const value = structuredClone(fixture);
    value.trackingResults.TrackedShipment.Carrier = 'Synthetic Other Network';
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value.trackingResults.TrackedShipment.Carrier = 'The Delivery Group';
    value.trackingResults.TrackedShipment.Items.push(structuredClone(value.trackingResults.TrackedShipment.Items[0]!));
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value.trackingResults.TrackedShipment.Items = [];
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires a whole returned identity and consistent canonical item, including verified aliases', () => {
    expect(() => parse(fixture, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parse(fixture, fixture.trackingResults.TrackedShipment.ClientShipmentReference).current_stage).toBe('delivered');
    expect(parse(fixture, fixture.trackingResults.TrackedShipment.Items[0]!.ClientitemReference).current_stage).toBe('delivered');
    const changed = structuredClone(fixture);
    changed.trackingResults.TrackedShipment.Items[0]!.CarrierItemReference = OTHER;
    expect(() => parse(changed)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps the empty envelope inconclusive for a known parcel without its postcode and keeps malformed replies inconclusive', () => {
    expect(() => parse({ success: false })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const value of [null, [], {}, { success: false, error: 'verification' }, { success: true },
      { success: true, trackingResults: {} }, { success: false, trackingResults: {} }]) {
      expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTdg('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTdg('<html>No records</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const value = structuredClone(fixture);
    value.trackingResults.TrackedShipment.Items[0]!.ItemEvents = [];
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value.trackingResults.TrackedShipment.IsTrackingAvailable = false;
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects changed scan calendars, unexpected times and new milestone meanings', () => {
    for (const bad of [
      { EventDate: '31/02/2026' }, { EventDate: '2026-09-30' }, { EventTime: '25:26' },
      { EventTime: '09:26Z' }, { Description: 'Synthetic new movement' },
    ]) {
      const value = structuredClone(fixture);
      Object.assign(value.trackingResults.TrackedShipment.Items[0]!.ItemEvents[0]!, bad);
      expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('bounds histories without silently treating a truncated result as complete', () => {
    const value = structuredClone(fixture), row = value.trackingResults.TrackedShipment.Items[0]!.ItemEvents[0]!;
    value.trackingResults.TrackedShipment.Items[0]!.ItemEvents = Array.from({ length: 101 }, () => row);
    expect(parse(value)).toMatchObject({ history_truncated: true });
    expect(parse(value).events).toHaveLength(100);
    value.trackingResults.TrackedShipment.Items[0]!.ItemEvents = Array.from({ length: 501 }, () => row);
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the supplied transport for one number-only POST without credentials or document reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toBe(TDG_TRACKING_URL);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ trackingQuery: { Reference: NUMBER, Postcode: '' } });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(headers.has('Cookie')).toBe(false);
      return new Response(JSON.stringify(fixture));
    });
    expect((await new TheDeliveryGroupTracker({ fetcher }).fetch(NUMBER)).events).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('passes an optional delivery postcode through the SDK and rejects invalid input before I/O', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ trackingQuery: { Reference: NUMBER, Postcode: 'SW1A 1AA' } });
      return new Response(JSON.stringify(fixture));
    });
    const result = await createTracker({ fetcher, env: {}, providers: [] }).track({
      number: NUMBER, carrier: 'the-delivery-group', postcode: ' sw1a  1aa ',
    }, { budgetMs: 5000 });
    expect(result.result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(new TheDeliveryGroupTracker({ fetcher }).fetch(NUMBER, '<invalid>')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a known parcel unresolved when DocketHub omits it for the postcode pair', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"success":false}'));
    await expect(createTracker({ fetcher, env: {}, providers: [] }).track({
      number: NUMBER, carrier: 'the-delivery-group',
    }, { budgetMs: 5000 })).rejects.toMatchObject({ attempts: [expect.objectContaining({ kind: 'indeterminate' })] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves rate limits, redirects, cancellation and exhausted budgets', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('limited', { status: 429, headers: { 'Retry-After': '5' } }));
    await expect(new TheDeliveryGroupTracker({ fetcher: limited }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5000 });
    const redirected = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://other.invalid/' } }));
    await expect(new TheDeliveryGroupTracker({ fetcher: redirected }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(new TheDeliveryGroupTracker({ fetcher }).fetch(NUMBER, '', { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(new TheDeliveryGroupTracker({ fetcher }).fetch(NUMBER, '', { signal: AbortSignal.abort(Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const value of ['', 'A'.repeat(7), 'A'.repeat(31), 'https://other.invalid']) expect(() => normalizeTdgNumber(value)).toThrow();
  });

  it('serves the selected carrier through the SDK while retaining its native clocks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture)));
    const result = await createTracker({ fetcher, env: {}, providers: [] }).track({ number: NUMBER, carrier: 'the-delivery-group' }, { budgetMs: 5000 });
    expect(result).toMatchObject({ source: 'the-delivery-group', carrier: 'the-delivery-group',
      result: { current_stage: 'delivered', last_update_local: '2026-09-30T09:26:00' } });
    expect(result.result.events?.[0]?.time).toBe('2026-09-30T09:26:00');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
