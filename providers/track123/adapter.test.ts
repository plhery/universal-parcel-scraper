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
  it("dates Japan Post's scans at a place with a Japanese postcode on Tokyo time, whatever offset Track123 gives", () => {
    const japan = (address: string) => ({ code: '00000', data: { landWaybillLists: [{ trackingNo: NUMBER, localProviderCode: 'japan-post',
      localProviderEnName: 'Japan Post', querying: false, nodeStatus: 'NORMAL_QUERY', localDetails: [{ trackingNo: NUMBER,
        eventTime: '2026-01-08 09:20:00', timezone: '+08:00', eventTimeUtc: '2026-01-08 01:20:00',
        eventDetail: 'Dispatch from outward office of exchange', address }] }] } });
    expect(parseTrack123Response(japan('EXAMPLE,EXAMPLE KEN,100-0001'), NUMBER, 'japan-post').events).toMatchObject([
      { time: '2026-01-08T00:20:00.000Z', local_time: '2026-01-08T09:20:00' }]);
    // A place elsewhere keeps the offset Track123 gives.
    expect(parseTrack123Response(japan('EXAMPLE'), NUMBER, 'japan-post').events).toMatchObject([{ time: '2026-01-08T01:20:00.000Z' }]);
    const fedex = fixture(); fedex.data.landWaybillLists[0]!.localDetails[0]!.address = 'EXAMPLE,100-0001';
    expect(parseTrack123Response(fedex, NUMBER).events).toMatchObject([{ time: '2026-01-08T15:00:00.000Z' }]);
  });
  it("reads China Post's copies of the destination post's scans on the country they name, or on their wall clock alone", () => {
    const china = (...rows: [string, string, string][]) => ({ code: '00000', data: { landWaybillLists: [{ trackingNo: NUMBER,
      localProviderCode: 'china-post', localProviderEnName: 'China Post', querying: false, nodeStatus: 'NORMAL_QUERY',
      localDetails: rows.map(([eventTime, eventTimeUtc, eventDetail]) => ({ trackingNo: NUMBER, eventTime, timezone: '+08:00', eventTimeUtc,
        eventDetail, address: '' })) }] } });
    const departed = ['2026-01-09 20:58:00', '2026-01-09 12:58:00', '离开【法国】处理中心'] as [string, string, string];
    const arrived = ['2026-01-08 08:47:00', '2026-01-08 00:47:00', '到达寄达地处理中心'] as [string, string, string];
    const exported = ['2026-01-05 14:16:00', '2026-01-05 06:16:00', '出口海关/放行'] as [string, string, string];
    expect(parseTrack123Response(china(departed, arrived, exported), NUMBER, 'china-post').events).toMatchObject([
      { time: '2026-01-09T19:58:00.000Z', local_time: '2026-01-09T20:58:00', time_zone: 'Europe/Paris', time_zone_basis: 'place' },
      { time: '2026-01-08T07:47:00.000Z', local_time: '2026-01-08T08:47:00', time_zone: 'Europe/Paris', time_zone_basis: 'neighbour' },
      { time: '2026-01-05T06:16:00.000Z', local_time: '2026-01-05T14:16:00' },
    ]);
    // With no country named, the destination post's scan keeps its wall clock; China Post's own keeps the label.
    const [unplaced, origin] = parseTrack123Response(china(arrived, exported), NUMBER, 'china-post').events!;
    expect(unplaced).toMatchObject({ local_time: '2026-01-08T08:47:00' }); expect(unplaced).not.toHaveProperty('time');
    expect(origin).toMatchObject({ time: '2026-01-05T06:16:00.000Z' });
    // A country on several clocks lends none.
    for (const row of parseTrack123Response(china(['2026-01-09 20:58:00', '2026-01-09 12:58:00', '离开【美国】处理中心'], arrived), NUMBER,
      'china-post').events!) {
      expect(row).not.toHaveProperty('time'); expect(row).not.toHaveProperty('time_zone');
    }
    // Another courier's rows in the same words keep Track123's label.
    expect(parseTrack123Response({ ...china(arrived), data: { landWaybillLists: [{ ...china(arrived).data.landWaybillLists[0]!, localProviderCode: 'fedex' }] } },
      NUMBER).events).toMatchObject([{ time: '2026-01-08T00:47:00.000Z' }]);
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
