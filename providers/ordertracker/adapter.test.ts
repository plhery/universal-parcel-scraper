import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { universalSourceBudget } from '../plan.js';
import { adapter, ORDERTRACKER_API, ORDERTRACKER_BUDGET_MS, parseOrdertrackerResponse } from './adapter.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as {
  status: { code: string }; events: Array<{ time: string; lines: Array<{ original: string }>; carrier: { name: string } | null }>; carriers: unknown[];
};
const READ_AT = Date.parse('2026-11-21T00:00:00Z');
const parse = (name: string, carrier: string) => parseOrdertrackerResponse(fixture(name), carrier, READ_AT);

describe('Ordertracker replies', () => {
  it("reads both feeds' copies of a UPS scan as one, on the scanning place's clock", () => {
    const result = parse('ups-1Z2231040309026972', 'ups');
    expect(result).toMatchObject({ tracking_provider: 'Ordertracker', current_stage: 'delivered', tracking_source: 'structured-web-response' });
    // 26 rows: Pitney Bowes's and FAR's copies of 16 scans, a copy often with the place alone.
    expect(result.events).toHaveLength(16);
    expect(result.events![0]).toMatchObject({ time: '2026-09-25T12:59:53-06:00', local_time: '2026-09-25T12:59:53', description: 'DELIVERED',
      location: 'DUBOIS, WY', time_zone: 'America/Denver', time_zone_basis: 'place' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-09-16T10:26:36-04:00', stage: 'registered' });
    expect(new Set(result.events!.map((event) => event.time)).size).toBe(16);
  });

  it("splits FedEx's one-line scans into wording, place and detail, at the instants the feed gives", () => {
    const { events } = parse('fedex-541270563758', 'fedex');
    expect(events![0]).toMatchObject({ time: '2026-09-08T14:09:37.000Z', stage: 'delivered', location: 'Ocala, US',
      description: 'Delivered — Left in mail room. Signature Service not requested.' });
    expect(events![1]).toMatchObject({ description: 'On FedEx vehicle for delivery', location: 'OCALA, US' });
    // The pickup, dated by its day alone.
    expect(events!.find((event) => event.stage === 'accepted')).toEqual(expect.objectContaining({ local_time: '2026-09-01', description: 'Picked up' }));
    expect(events!.find((event) => event.stage === 'accepted')).not.toHaveProperty('time');
  });

  it("keeps only the carrier's feeds, dating a wall-clock copy by its place", () => {
    const { events, current_stage } = parse('canada-post-LA586492541CA', 'canada-post');
    expect(current_stage).toBe('out_for_delivery');
    // 24 rows: Canada Post's, Pitney Bowes's copies of some of them and the postal union's one row.
    expect(events).toHaveLength(12);
    expect(events![0]).toMatchObject({ time: '2026-10-10T11:10:00.000Z', description: 'Item out for delivery' });
    expect(events!.find((event) => event.location === 'CHICAGO,USA')).toMatchObject({ time: '2026-10-04T15:24:00-05:00', time_zone: 'America/Chicago' });
  });

  it('dates a scan that lost its place by the scans around it, then leaves out the place-only rows', () => {
    const { events } = parse('usps-9400136208303575551300', 'usps');
    expect(events).toHaveLength(9);
    expect(events![0]).toMatchObject({ time: '2026-07-27T14:12:00-07:00', stage: 'delivered', time_zone: 'America/Los_Angeles' });
    expect(events!.find((event) => event.description === 'Departed USPS Facility')).toMatchObject({ time: '2026-07-24T01:14:00-07:00' });
    expect(events!.find((event) => event.description === 'Processed through USPS Facility')).toMatchObject({
      time: '2026-07-22T07:52:00-04:00', location: 'PHILADELPHIA PA DISTRIBUTION CENTER', time_zone_basis: 'place' });
  });

  it('gives no history when the newest scan kept only its place', () => {
    // The delivery, relayed as "ISLAND PARK, NY": an older scan must not stand for where the parcel is.
    expect(() => parse('usps-LS020782045US', 'usps')).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'incomplete_history' }));
  });

  it("reads La Poste's wording at the feed's instants", () => {
    const { events } = parse('la-poste-6H14479158377', 'la-poste');
    expect(events).toHaveLength(6);
    expect(events![0]).toMatchObject({ time: '2026-09-30T15:15:00.000Z', stage: 'delivered', description: 'Votre colis est livré.' });
    // Midnight UTC is two in the morning in France: a scan's time, not its day.
    const night = fixture('la-poste-6H14479158377');
    night.events.at(-1)!.time = '2026-09-28T00:00:00.001Z';
    const oldest = parseOrdertrackerResponse(night, 'la-poste', READ_AT).events!.at(-1)!;
    expect(oldest).toMatchObject({ time: '2026-09-28T00:00:00.000Z', stage: 'registered' });
    expect(oldest).not.toHaveProperty('local_time');
  });

  it('turns a reply without any feed, or without the carrier\'s, into no history', () => {
    expect(() => parse('no-information', 'usps')).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parse('fedex-541270563758', 'ups')).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'unattributed_history' }));
  });

  it('refuses a carrier whose feeds were not checked, and a reply it cannot read', () => {
    expect(() => parse('la-poste-6H14479158377', 'dhl')).toThrow(expect.objectContaining({ reason: 'unsupported_scope' }));
    expect(() => parseOrdertrackerResponse({ events: [] }, 'ups')).toThrow(expect.objectContaining({ name: 'SchemaError' }));
    const undated = fixture('la-poste-6H14479158377');
    undated.events[0]!.time = '2026-09-30 15:15';
    expect(() => parseOrdertrackerResponse(undated, 'la-poste', READ_AT)).toThrow(expect.objectContaining({ name: 'SchemaError' }));
  });
});

describe('Ordertracker lookups', () => {
  const tracker = (fetcher: typeof fetch) => adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

  it("asks the app's endpoint about the number and links the public page", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture('la-poste-6H14479158377'))));
    const result = await tracker(fetcher).track({ number: '6h14479158377', carrier: 'la-poste' });
    expect(result).toMatchObject({ tracking_provider: 'Ordertracker', current_stage: 'delivered', tracking_url: 'https://www.ordertracker.com/track/6H14479158377' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ORDERTRACKER_API}?trackingNumber=6H14479158377&lang=en`);
    expect(new Headers(init?.headers).get('X-Mobile-Secret')).toBeTruthy();
  });

  it('sends nothing for a lookup without a checked carrier', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(tracker(fetcher).track({ number: '6H14479158377' })).rejects.toMatchObject({ reason: 'unsupported_scope' });
    await expect(tracker(fetcher).track({ number: '6H14479158377', carrier: 'dhl' })).rejects.toMatchObject({ reason: 'unsupported_scope' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('waits for the "No information" Ordertracker gives after up to 45 s', () => {
    expect(ORDERTRACKER_BUDGET_MS).toBeGreaterThan(45_000);
    expect(universalSourceBudget('Ordertracker')).toBe(ORDERTRACKER_BUDGET_MS);
  });

  it('keeps a failing reply a provider failure, not a missing parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('error code: 522', { status: 522 }));
    await expect(tracker(fetcher).track({ number: '6H14479158377', carrier: 'la-poste' })).rejects.not.toMatchObject({ name: 'NoHistoryError' });
  });
});
