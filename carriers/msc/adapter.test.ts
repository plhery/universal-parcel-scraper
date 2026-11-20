import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { ChallengeError } from '../../core/errors/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MSC_USER_AGENT } from './adapter.js';
import { fetchMscInBrowser } from './browser.js';
import { containerCheckDigit, MSC_LOOKUP, mscPageUrl, mscQuery, mscReplyText, mscRequestBody, mscResult } from './parser.js';
import { mscStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

vi.mock('./browser.js', () => ({ fetchMscInBrowser: vi.fn() }));

// The public samples: four bills of lading and the first bill's container. Other numbers are synthetic.
const BILL = 'MEDUXG306947';
const CONTAINER = 'BEAU2978861';
const RAIL = 'MEDUXG247851';
const PANAMA = 'MEDUSA672436';
const BOSTON = 'MEDURN080417';
const BOOKING = '999999999';

type Row = Record<string, unknown>;
type Container = Row & { ContainerNumber: string; Events: Row[] };
type Bill = Row & { BillOfLadingNumber: string; ContainersInfo: Container[] };
type Reply = Row & { IsSuccess: boolean; Data: Row & { TrackingType: string; TrackingNumber: string; CurrentDate: string; BillOfLadings: Bill[] } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/tracking-${name}.json`, import.meta.url), 'utf8')) as Reply;
const read = (name: string, edit?: (reply: Reply) => void, number = name) => {
  const reply = fixture(name);
  edit?.(reply);
  const result = mscResult(reply, mscQuery(number));
  return { ...result, events: result.events ?? [] };
};
const rows = (result: ReturnType<typeof read>) => result.events.map(event => [event.local_time, event.description, event.location, event.stage ?? null]);
const container = (reply: Reply, index = 0) => reply.Data.BillOfLadings[0]!.ContainersInfo[index]!;
// MSC's answer for a number it does not hold, for each kind it looks up.
const missing = (label: string) => JSON.stringify({ IsSuccess: false, Data: `No results found for this ${label}. Please recheck the number and try again.` });

const NEWARK = 'PORT NEWARK CONTAINER TERMINAL, NEW YORK, US';
const VILA_VELHA = 'TERMINAL DE VILA VELHA, VITORIA, BR';

describe('MSC tracking replies', () => {
  it('reads a bill\'s container moves newest first on their days, with the terminal before the place', () => {
    const result = read(BILL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty received at CY', last_update: null, last_update_local: '2026-10-05', expected_delivery: null });
    expect(result).not.toHaveProperty('planned_events');
    expect(rows(result)).toEqual([
      ['2026-10-05', 'Empty received at CY', 'MAHER TERMINALS, NEW YORK, US', 'delivered'],
      ['2026-10-01', 'Import to consignee', NEWARK, 'out_for_delivery'],
      ['2026-09-29', 'Full Available for Delivery', NEWARK, 'ready_for_pickup'],
      ['2026-09-29', 'Import Discharged from Vessel', NEWARK, 'in_transit'],
      ['2026-09-25', 'Carrier release', 'NEW YORK, US', null],
      ['2026-08-15', 'Full Transshipment Loaded', 'MULTITERMINAIS RIO DE JANEIRO, RIO DE JANEIRO, BR', 'in_transit'],
      ['2026-08-08', 'Full Transshipment Discharged', 'MULTITERMINAIS RIO DE JANEIRO, RIO DE JANEIRO, BR', 'in_transit'],
      ['2026-08-04', 'Export Loaded on Vessel', VILA_VELHA, 'in_transit'],
      ['2026-08-01', 'Export received at CY', VILA_VELHA, 'accepted'],
      ['2026-07-22', 'Empty to Shipper', 'MEDLOG VIX, VILA VELHA, BR', 'registered'],
    ]);
    expect(result.events[0]).toEqual({ local_time: '2026-10-05', location: 'MAHER TERMINALS, NEW YORK, US', description: 'Empty received at CY',
      stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads a container\'s own moves, a rail leg, and the end of an import cycle', () => {
    expect(read(CONTAINER)).toEqual(read(BILL));
    expect(read(CONTAINER, reply => {
      reply.Data.BillOfLadings[0]!.ContainersInfo.unshift({ ...container(reply), ContainerNumber: 'ZZZU9999992', Events: container(reply).Events.slice(0, 1) });
    })).toEqual(read(BILL));
    const rail = read(RAIL);
    expect(rail).toMatchObject({ status: 'delivered', last_status_text: 'Empty received at origin rail ramp', last_update_local: '2026-07-10' });
    expect(rows(rail).slice(1, 9).map(([, description, , stage]) => [description, stage])).toEqual([
      ['Import to consignee', 'out_for_delivery'], ['Free Time to Expire', null], ['Full Available for Delivery', 'ready_for_pickup'],
      ['Import Unloaded from Rail', 'in_transit'], ['Import Arrived at Destination Rail Ramp', 'in_transit'], ['Carrier release', null],
      ['Import Rail Departure', 'in_transit'], ['Import Loaded on Rail', 'in_transit'],
    ]);
    expect(read(PANAMA)).toMatchObject({ status: 'delivered', last_status_text: 'End Import Cycle', last_update_local: '2026-06-29' });
    expect(read(BOSTON)).toMatchObject({ status: 'delivered', last_status_text: 'Empty received at CY', last_update_local: '2026-08-19' });
  });

  it('delivers a bill only once every container is back, and keeps the moves its containers share once', () => {
    const second = (reply: Reply, events: (moves: Row[]) => Row[]) => {
      reply.Data.BillOfLadings[0]!.ContainersInfo.push({ ...container(reply), ContainerNumber: 'ZZZU9999992', Events: events(container(reply).Events) });
    };
    const waiting = read(BILL, reply => second(reply, moves => moves.slice(1)));
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Empty received at CY' });
    expect(waiting.events).toHaveLength(10);
    const unmoved = read(BILL, reply => second(reply, moves => moves.filter(move => move.Description === 'Carrier release')));
    expect(unmoved).toMatchObject({ status: 'unknown', last_update_local: '2026-10-05' });
    expect(unmoved).not.toHaveProperty('current_stage');
    expect(read(BILL, reply => second(reply, moves => moves))).toEqual(read(BILL));
  });

  it('reads an empty container returned before it moved as no delivery, and a move back to a yard after it moved as transit', () => {
    const unused = read(BILL, reply => {
      container(reply).Events = container(reply).Events.slice(-1).concat({ ...container(reply).Events[0]!, Order: 99, Date: '24/07/2026' });
    });
    expect(unused).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Empty received at CY' });
    expect(unused.events[0]).not.toHaveProperty('stage');
    const relayed = read(BILL, reply => {
      container(reply).Events.unshift({ ...container(reply).Events.at(-2)!, Order: 99, Date: '06/10/2026' });
    });
    expect(relayed.events[0]).toMatchObject({ description: 'Export received at CY', stage: 'in_transit' });
  });

  it('keeps the moves dated after the reply\'s day and the estimated arrival as planned steps', () => {
    const sailing = read(BILL, reply => {
      reply.Data.CurrentDate = '20/08/2026';
      container(reply).Events.unshift({ ...container(reply).Events[3]!, Order: 99, Date: '28/09/2026', Description: 'Estimated Time of Arrival' });
    });
    expect(sailing).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Full Transshipment Loaded',
      last_update: null, last_update_local: '2026-08-15' });
    expect(sailing.events).toHaveLength(5);
    expect(sailing.planned_events).toEqual([
      { local_time: '2026-09-25', description: 'Carrier release', location: 'NEW YORK, US' },
      { local_time: '2026-09-28', description: 'Estimated Time of Arrival', location: NEWARK, stage: 'in_transit' },
      { local_time: '2026-09-29', description: 'Import Discharged from Vessel', location: NEWARK, stage: 'in_transit' },
      { local_time: '2026-09-29', description: 'Full Available for Delivery', location: NEWARK, stage: 'ready_for_pickup' },
      { local_time: '2026-10-01', description: 'Import to consignee', location: NEWARK, stage: 'out_for_delivery' },
      { local_time: '2026-10-05', description: 'Empty received at CY', location: 'MAHER TERMINALS, NEW YORK, US', stage: 'delivered' },
    ]);
  });

  it('answers no history for a shipment MSC lists without moves', () => {
    expect(() => read(BILL, reply => { container(reply).Events = []; })).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => read(BILL, reply => { reply.Data.CurrentDate = '01/07/2026'; })).toThrowError(expect.objectContaining({ reason: 'listed',
      plannedEvents: expect.arrayContaining([expect.objectContaining({ description: 'Empty to Shipper' })]) }));
  });

  it('reads a booking in its own mode', () => {
    const booked = read(BILL, reply => {
      Object.assign(reply.Data, { TrackingType: 'Booking Number', TrackingNumber: BOOKING });
      reply.Data.BillOfLadings[0]!.BillOfLadingNumber = 'MEDU99999999';
    }, BOOKING);
    expect(booked).toEqual(read(BILL));
    expect(JSON.parse(mscRequestBody(mscQuery(BOOKING)))).toEqual({ trackingNumber: BOOKING, trackingMode: '1' });
  });

  it('reads MSC\'s answer for a number it does not hold only for the kind looked up', () => {
    expect(() => mscReplyText(missing('Bill of Lading number'), mscQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => mscReplyText(missing('Container number'), mscQuery(CONTAINER))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => mscReplyText(missing('Booking number'), mscQuery(BOOKING))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => mscReplyText(missing('Container number'), mscQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => mscReplyText(JSON.stringify({ IsSuccess: false, Data: 'Something went wrong' }), mscQuery(BILL)))
      .toThrowError(expect.objectContaining({ kind: 'transport' }));
  });

  it('reads Akamai\'s refusal and its empty reply as a challenge, and other pages as a changed reply', () => {
    for (const body of ['', ' \n', '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.0</BODY></HTML>']) {
      expect(() => mscReplyText(body, mscQuery(BILL)), body).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(() => mscReplyText('<html><body>Maintenance</body></html>', mscQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(mscReplyText(`\uFEFF${JSON.stringify(fixture(BILL))}`, mscQuery(BILL))).toMatchObject({ last_update_local: '2026-10-05' });
  });

  it('refuses a reply for another number, another kind of lookup or another shipment, and a changed one', () => {
    const fails = (name: string, edit: (reply: Reply) => void) => expect(() => read(name, edit)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(BILL, reply => { reply.Data.TrackingNumber = 'MEDUZZ999999'; });
    fails(BILL, reply => { reply.Data.TrackingType = 'Container'; });
    fails(CONTAINER, reply => { reply.Data.TrackingType = 'Bill Of Lading'; });
    fails(CONTAINER, reply => { container(reply).ContainerNumber = 'ZZZU9999992'; });
    fails(BILL, reply => { reply.Data.BillOfLadings[0]!.BillOfLadingNumber = 'MEDUZZ999999'; });
    fails(BILL, reply => { reply.Data.CurrentDate = '2026-11-20'; });
    fails(BILL, reply => { container(reply).Events[0]!.Date = '31/02/2026'; });
    fails(BILL, reply => { container(reply).Events[0]!.Date = '05/10/1999'; });
    fails(BILL, reply => { container(reply).Events[0]!.Order = '9'; });
    fails(BILL, reply => { container(reply).Events[0]!.Description = ''; });
    fails(BILL, reply => { container(reply).Events[0]!.Location = 7; });
    fails(BILL, reply => { container(reply).Events[0]!.EquipmentHandling = 'MAHER'; });
    fails(BILL, reply => { container(reply).Events = {} as never; });
    fails(BILL, reply => { reply.Data.BillOfLadings = [null] as never; });
    expect(() => mscResult([], mscQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => mscReplyText('{"IsSuccess":true', mscQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });
});

const ok = (name: string) => new Response(JSON.stringify(fixture(name)), { status: 200, headers: { 'content-type': 'application/json' } });
const carrier = (fetcher: typeof fetch, browserExecutablePath: string | null = '/synthetic/chromium', recorder: StepRecorder = NOOP_RECORDER) =>
  adapter({ fetcher, recorder, env: {}, trawl: null, browserExecutablePath });

describe('MSC adapter', () => {
  it('takes a container with its check digit, a bill with MEDU, or a booking, and nothing else', async () => {
    expect([containerCheckDigit('BEAU297886'), containerCheckDigit('ZZZU999999')]).toEqual([1, 2]);
    expect(mscQuery(' beau 297886-1 ')).toEqual({ kind: 'container', number: CONTAINER });
    expect(mscQuery('medu xg306947')).toEqual({ kind: 'bill', number: BILL });
    expect(mscQuery(BOOKING)).toEqual({ kind: 'booking', number: BOOKING });
    expect(mscPageUrl(mscQuery(BILL))).toBe(`https://www.msc.com/en/track-a-shipment?params=${encodeURIComponent(btoa(`trackingNumber=${BILL}&trackingMode=0`))}`);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['BEAU2978862', 'XG 306', 'ABCDEFGHI', 'MEDU-XG30', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts the number and its mode as the tracking page does, with a browser\'s name', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ok(BILL));
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, null, recorder).track({ number: BILL })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(MSC_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ trackingNumber: BILL, trackingMode: '0' }) });
    const headers = new Headers(init!.headers);
    expect([headers.get('user-agent'), headers.get('content-type'), headers.get('referer')])
      .toEqual([MSC_USER_AGENT, 'application/json', 'https://www.msc.com/en/track-a-shipment']);
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
    expect(vi.mocked(fetchMscInBrowser)).not.toHaveBeenCalled();
  });

  it('opens the tracking page in a local browser when Akamai refuses the lookup, and only then', async () => {
    const browser = vi.mocked(fetchMscInBrowser).mockClear().mockResolvedValue(read(BILL));
    for (const refusal of [() => new Response('<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>', { status: 403 }), () => new Response('', { status: 200 })]) {
      browser.mockClear();
      await expect(carrier(async () => refusal()).track({ number: BILL })).resolves.toMatchObject({ current_stage: 'delivered' });
      expect(browser).toHaveBeenCalledWith({ kind: 'bill', number: BILL }, '/synthetic/chromium', expect.any(AbortSignal), expect.any(Number));
    }
    browser.mockClear();
    await expect(carrier(async () => new Response('', { status: 403 }), null).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => new Response(missing('Bill of Lading number'))).track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(async () => new Response('', { status: 429 })).track({ number: BILL })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(browser).not.toHaveBeenCalled();
    browser.mockRejectedValue(new ChallengeError('MSC'));
    await expect(carrier(async () => new Response('', { status: 403 })).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('asks once more when the lookup does not reach MSC', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(ok(CONTAINER));
    await expect(carrier(fetcher, null).track({ number: CONTAINER })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is asked when the number is filed under MSC', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => ok(BILL));
    await expect(createTracker({ providers: [], env: {}, fetcher }).track({ number: BILL, carrier: 'msc' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'msc', source: 'msc', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('msc').tracking).toMatchObject({ adapter: 'msc', browser: true, localClocks: true, dateOnlyScans: true });
  });
});

describe('MSC status vocabulary', () => {
  it('stages each wording the page gives, and leaves the notices without a stage', () => {
    for (const entry of statuses.entries) {
      expect(mscStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'msc', providerCode: null, description: entry.wording }).kind, entry.wording)
        .toBe(entry.stage ? 'mapped' : 'intentional_gap');
    }
    expect(mscStage('Empty received')).toBeUndefined();
    expect(statusMap.stage(null, 'export loaded on vessel')).toBe('in_transit');
  });
});
