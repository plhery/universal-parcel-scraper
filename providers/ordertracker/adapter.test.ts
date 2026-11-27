import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { stillReadingMs } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { universalSourceBudget, universalSourcePatience } from '../plan.js';
import { adapter, ORDERTRACKER_API, ORDERTRACKER_BUDGET_MS, ORDERTRACKER_READ_MS, parseOrdertrackerResponse } from './adapter.js';

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

  it("reads Mail Boxes Etc's FedEx scans east of Greenwich on their place's wall clock, the others at their instants", () => {
    const scan = (time: string, original: string) => ({ time, lines: [{ original }], carrier: { name: 'MAIL BOXES ETC' } });
    const payload = { ...fixture('fedex-541270563758'), events: [
      scan('2026-11-27T08:35:00.005Z', 'On FedEx vehicle for delivery EXAMPLEDORF DE'),
      scan('2026-11-27T00:22:00.004Z', 'Arrived at FedEx hub PARIS FR'),
      scan('2026-11-26T19:03:00.003Z', 'Departed FedEx hub MEMPHIS US'),
      scan('2026-11-26T17:53:00.002Z', 'Picked up EXAMPLE CITY US'),
      scan('2026-11-26T13:45:04.001Z', 'Shipment information sent to FedEx'),
    ] };
    const { events } = parseOrdertrackerResponse(payload, 'fedex', Date.parse('2026-11-28T00:00:00Z'));
    expect(events!.map((event) => [event.time, event.time_zone])).toEqual([
      // FedEx's own: 08:35 and 00:22 at +01:00. A town the places do not know takes its country's clock.
      ['2026-11-27T08:35:00+01:00', 'Europe/Berlin'],
      ['2026-11-27T00:22:00+01:00', 'Europe/Paris'],
      // The scans in the United States and the label without a place are instants.
      ['2026-11-26T19:03:00.000Z', undefined],
      ['2026-11-26T17:53:00.000Z', undefined],
      ['2026-11-26T13:45:04.000Z', undefined],
    ]);
    expect(events![0]).toMatchObject({ local_time: '2026-11-27T08:35:00', time_zone_basis: 'place', stage: 'out_for_delivery' });
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

describe('Ordertracker reads that outlast a lookup', () => {
  const tracker = (fetcher: typeof fetch) => adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
  const parcel = { number: 'LA586492541CA', carrier: 'canada-post' };
  const history = () => new Response(JSON.stringify(fixture('canada-post-LA586492541CA')));
  const noInformation = () => new Response(JSON.stringify(fixture('no-information')));
  /** A request whose reply comes after `ms` on the test's clock, unless its signal ends it first. */
  const after = (ms: number, reply: () => Response): typeof fetch => (_url, init) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(reply()), ms);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason as Error); }, { once: true });
  });
  const failure = (pending: Promise<unknown>) => pending.then(() => { throw new Error('answered'); }, (error: unknown) => error);

  it('gives a lookup someone waits for less time than its reads take, and a parcel it finds enough', () => {
    expect(universalSourcePatience('Ordertracker')).toBeGreaterThan(13_000);
    expect(universalSourcePatience('Ordertracker')).toBeLessThan(ORDERTRACKER_READ_MS);
    expect(ORDERTRACKER_READ_MS).toBeLessThan(ORDERTRACKER_BUDGET_MS);
    expect(universalSourcePatience('Ship24')).toBe(universalSourceBudget('Ship24'));
  });

  it('says it is still reading when the budget ends first, with the wait until the read does', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>(after(45_000, noInformation));
    const error = await failure(clock.settle(tracker(fetcher).track(parcel, { budgetMs: 15_000 })));
    expect(error).toMatchObject({ kind: 'indeterminate', reason: 'still_reading' });
    expect(stillReadingMs(error)).toBeGreaterThan(ORDERTRACKER_READ_MS - 15_100);
    expect(stillReadingMs(error)).toBeLessThanOrEqual(ORDERTRACKER_READ_MS - 15_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('takes the history a second ask finds once the read is over', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(after(45_000, noInformation)).mockImplementation(async () => history());
    const source = tracker(fetcher);
    await failure(clock.settle(source.track(parcel, { budgetMs: 15_000 })));
    await expect(clock.settle(source.track(parcel, { budgetMs: 30_000 }))).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads the "No information" of a read under way as no answer, and asks again when it ends', async () => {
    const clock = fakeBudgetClock();
    const asked: number[] = [];
    const started = performance.now();
    const fetcher = vi.fn<typeof fetch>((...request) => {
      asked.push(Math.round(performance.now() - started));
      return asked.length === 1 ? after(45_000, noInformation)(...request) : Promise.resolve(asked.length === 2 ? noInformation() : history());
    });
    const source = tracker(fetcher);
    await failure(clock.settle(source.track(parcel, { budgetMs: 15_000 })));
    await expect(clock.settle(source.track(parcel, { budgetMs: 40_000 }))).resolves.toMatchObject({ tracking_provider: 'Ordertracker' });
    expect(asked[1]).toBe(15_000);
    expect(asked[2]).toBeGreaterThanOrEqual(ORDERTRACKER_READ_MS);
    expect(asked).toHaveLength(3);
  });

  it('stays still reading when the budget ends before the read does', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(after(45_000, noInformation)).mockImplementation(async () => noInformation());
    const source = tracker(fetcher);
    await failure(clock.settle(source.track(parcel, { budgetMs: 15_000 })));
    const error = await failure(clock.settle(source.track(parcel, { budgetMs: 10_000 })));
    expect(error).toMatchObject({ reason: 'still_reading' });
    expect(stillReadingMs(error)).toBeGreaterThan(31_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes "No information" for the answer from the request that waited for the read, and after the read', async () => {
    const clock = fakeBudgetClock();
    const waited = vi.fn<typeof fetch>(after(45_000, noInformation));
    await expect(clock.settle(tracker(waited).track(parcel))).rejects.toMatchObject({ name: 'NoHistoryError' });
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(after(45_000, noInformation)).mockImplementation(async () => noInformation());
    const source = tracker(fetcher);
    await failure(clock.settle(source.track(parcel, { budgetMs: 15_000 })));
    const error = await failure(clock.settle(source.track(parcel, { budgetMs: 40_000 })));
    expect(error).toMatchObject({ name: 'NoHistoryError' });
    expect(stillReadingMs(error)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not take the "No information" a retry gets for the answer', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(after(20_000, () => new Response('', { status: 503 })))
      .mockImplementationOnce(async () => noInformation()).mockImplementation(async () => history());
    await expect(clock.settle(tracker(fetcher).track(parcel))).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps a request that outlasts the read itself a provider failure, and a cancelled one cancelled', async () => {
    const clock = fakeBudgetClock();
    const silent = vi.fn<typeof fetch>(after(120_000, noInformation));
    const late = await failure(clock.settle(tracker(silent).track(parcel)));
    expect(late).toMatchObject({ kind: 'transport' });
    expect(stillReadingMs(late)).toBeUndefined();
    const controller = new AbortController();
    const lookup = failure(tracker(vi.fn<typeof fetch>(after(45_000, noInformation))).track(parcel, { budgetMs: 15_000, signal: controller.signal }));
    controller.abort(new Error('cancelled'));
    expect(stillReadingMs(await clock.settle(lookup))).toBeUndefined();
  });
});
