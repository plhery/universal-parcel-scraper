import { describe, expect, it } from 'vitest';
import { parseTrack123Response, adapter, TRACK123_QUERY, TRACK123_POLL } from './adapter.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { universalPlan } from '../plan.js';

const NUMBER = '909876543210';
const event = { trackingNo: NUMBER, eventTime: '2026-01-08 10:00:00', timezone: '-05:00',
  eventTimeUtc: '2026-01-08 15:00:00', eventDetail: 'Delivered', address: 'Example facility' };
const fixture = () => ({ code: '00000', data: { landWaybillLists: [{ trackingNo: NUMBER, localProviderCode: 'fedex',
  localProviderName: 'FedEx', localProviderEnName: 'FedEx', querying: false, hasTrackingDetails: true, nodeStatus: 'NORMAL_QUERY',
  localDetails: [{ ...event }] }] } });
const PAKET = 'JJD000000000000000001';
const paket = () => ({ code: '00000', data: { landWaybillLists: [{ trackingNo: PAKET, localProviderCode: 'dhl-germany',
  localProviderName: 'DHL Paket', localProviderEnName: 'DHL Paket', querying: false, nodeStatus: 'NORMAL_QUERY',
  localDetails: [{ trackingNo: PAKET, eventTime: '2026-01-08 10:00:00', timezone: '+01:00', eventTimeUtc: '2026-01-08 09:00:00',
    eventDetail: 'Die Sendung wurde zugestellt.', address: 'Example' }] }] } });
const scrapeOf = (body: unknown) => ({ scrape: async (request: { url: string }) => ({ url: request.url, capturedResponses: [
  { url: TRACK123_POLL, status: 200, trackingNumberSubmitted: PAKET, body: JSON.stringify(body) }] }) });

describe('Track123 public courier history', () => {
  it('preserves the wall time and explicit offset as well as provider provenance', () => {
    expect(parseTrack123Response(fixture(), NUMBER)).toMatchObject({ tracking_provider: 'Track123', discovered_carrier: 'fedex',
      tracking_url: 'https://www.track123.com/carriers/fedex', reported_carriers: ['FedEx'], events: [{ time: '2026-01-08T15:00:00.000Z', local_time: '2026-01-08T10:00:00', stage: 'delivered' }] });
  });
  it('rejects another shipment, another provider and another event identity', () => {
    for (const change of [(p: ReturnType<typeof fixture>) => { p.data.landWaybillLists[0]!.trackingNo += '0'; },
      (p: ReturnType<typeof fixture>) => { p.data.landWaybillLists[0]!.localProviderCode = 'other'; },
      (p: ReturnType<typeof fixture>) => { p.data.landWaybillLists[0]!.localDetails[0]!.trackingNo = '908765432109'; }]) {
      const payload = fixture(); change(payload); expect(() => parseTrack123Response(payload, NUMBER)).toThrow(/match|Unbound/);
    }
  });
  it('does not turn rejection, polling or absent history into not-found', () => {
    expect(() => parseTrack123Response({ code: 'B0001' }, NUMBER)).toThrow(/refused/);
    const payload = fixture(); payload.data.landWaybillLists[0]!.querying = true;
    expect(() => parseTrack123Response(payload, NUMBER)).toThrow(/retrieving/);
    payload.data.landWaybillLists[0]!.querying = false; payload.data.landWaybillLists[0]!.localDetails = [];
    expect(() => parseTrack123Response(payload, NUMBER)).toThrow(/available tracking history/);
    payload.data.landWaybillLists[0]!.nodeStatus = 'UNSTABLE_OFFICIAL_WEBSITE';
    expect(() => parseTrack123Response(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'carrier_unavailable' }));
  });
  it('reads another courier asked by its code and names it as Track123 shows it', () => {
    expect(parseTrack123Response(paket(), PAKET, 'dhl-germany')).toMatchObject({ discovered_carrier: 'dhl', reported_carriers: ['DHL Paket'],
      tracking_url: 'https://www.track123.com/carriers/dhl-germany', events: [{ time: '2026-01-08T09:00:00.000Z', local_time: '2026-01-08T10:00:00' }] });
    expect(() => parseTrack123Response(paket(), PAKET)).toThrow(/match/);
    const other = paket(); other.data.landWaybillLists[0]!.localProviderCode = 'dhl';
    expect(() => parseTrack123Response(other, PAKET, 'dhl-germany')).toThrow(/match/);
  });
  it('asks the courier page of the named carrier and binds the answer to its code', async () => {
    const pages: string[] = [];
    const trawl = { scrape: async (request: { url: string }) => { pages.push(request.url); return scrapeOf(paket()).scrape(request); } } as unknown as TrawlClient;
    const tracker = adapter({ trawl, env: {}, recorder: NOOP_RECORDER, browserExecutablePath: null });
    await expect(tracker.track({ number: PAKET, carrier: 'dhl' })).resolves.toMatchObject({ discovered_carrier: 'dhl', reported_carriers: ['DHL Paket'] });
    expect(pages).toEqual([`https://www.track123.com/carriers/dhl-germany#trawl-number=${PAKET}`]);
    const wrong = paket(); wrong.data.landWaybillLists[0]!.localProviderCode = 'dhl';
    const misfiled = adapter({ trawl: scrapeOf(wrong) as unknown as TrawlClient, env: {}, recorder: NOOP_RECORDER, browserExecutablePath: null });
    await expect(misfiled.track({ number: PAKET, carrier: 'dhl' })).rejects.toThrow(/match/);
    await expect(tracker.track({ number: PAKET, carrier: 'example-carrier' })).rejects.toMatchObject({ reason: 'unsupported_scope' });
    await expect(tracker.track({ number: PAKET })).rejects.toMatchObject({ reason: 'unsupported_scope' });
    expect(pages).toHaveLength(1);
  });
  it('rejects contradictory clocks and keeps an unzoned clock local', () => {
    const payload = fixture(); payload.data.landWaybillLists[0]!.localDetails[0]!.timezone = '+01:00';
    expect(() => parseTrack123Response(payload, NUMBER)).toThrow(/Conflicting/);
    payload.data.landWaybillLists[0]!.localDetails[0]!.timezone = '';
    expect(parseTrack123Response(payload, NUMBER).events![0]).not.toHaveProperty('time');
  });
  it('is opt-in, and asked only about the carrier the lookup is for when its courier page is listed', () => {
    expect(universalPlan({ carriers: ['fedex'], trackingNumber: NUMBER }).sources).not.toContain('Track123');
    expect(universalPlan({ carriers: ['fedex'], trackingNumber: NUMBER, enableTrack123: true }).sources).toContain('Track123');
    expect(universalPlan({ carriers: ['dhl'], trackingNumber: PAKET, enableTrack123: true }).sources).toContain('Track123');
    // Its page for a carrier that is only confirmed or discovered for the number could answer for another parcel.
    expect(universalPlan({ carriers: ['usps', 'fedex'], trackingNumber: NUMBER, enableTrack123: true }).sources).not.toContain('Track123');
    expect(universalPlan({ carriers: [undefined, 'fedex'], trackingNumber: NUMBER, enableTrack123: true }).sources).not.toContain('Track123');
    expect(universalPlan({ trackingNumber: NUMBER, enableTrack123: true }).sources).not.toContain('Track123');
  });
  it('takes its place by the history its page had for the carrier, among the browser providers', () => {
    // Someone waits: the HTTP providers with the same history are asked first.
    const waited = universalPlan({ carriers: ['fedex'], trackingNumber: NUMBER, enableTrack123: true });
    expect(waited.tier('Track123')).toBe('full');
    expect(waited.sources.indexOf('Track123')).toBeGreaterThan(waited.sources.indexOf('ParcelsApp'));
    // Nobody waits: it shares the carrier's numbers with the providers of its tier.
    const first = new Set(Array.from({ length: 400 }, (_, index) => universalPlan({ carriers: ['fedex'],
      trackingNumber: String(900000000000 + index), enableTrack123: true, background: true }).sources[0]));
    expect(first).toContain('Track123');
    expect(first).toContain('ParcelsApp');
  });
  it('does not hide a failed poll behind an earlier history', async () => {
    const trawl = { scrape: async () => ({ capturedResponses: [
      { url: TRACK123_QUERY, status: 200, trackingNumberSubmitted: NUMBER, body: JSON.stringify(fixture()) },
      { url: TRACK123_POLL, status: 0, trackingNumberSubmitted: NUMBER, body: null, error: 'request-failed' },
    ] }) } as unknown as TrawlClient;
    const tracker = adapter({ trawl, env: {}, recorder: NOOP_RECORDER, browserExecutablePath: null });
    await expect(tracker.track({ number: NUMBER, carrier: 'fedex' })).rejects.toThrow(/Incomplete/);
    await expect(tracker.track({ number: NUMBER, carrier: 'example-carrier' })).rejects.toThrow(/named carrier/);
  });
});
