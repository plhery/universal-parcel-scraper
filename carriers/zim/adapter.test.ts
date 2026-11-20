import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ZIM_USER_AGENT } from './adapter.js';
import { fetchZimInBrowser } from './browser.js';
import { containerCheckDigit, ZIM_SUBSCRIPTION_KEY, zimLookupUrl, zimPageUrl, zimQuery, zimReplyText, zimResult } from './parser.js';
import { statusMap, zimStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

vi.mock('./browser.js', () => ({ fetchZimInBrowser: vi.fn() }));

// The public samples: five bills of lading and the second bill's container. Other numbers are synthetic.
const BILL = 'ZIMUSEL71213411';
const TAKEN_OUT = 'ZIMUSHH32340236';
const CONTAINER = 'TCNU2975217';
const RETURNED = 'ZIMUSHH32336300';
const INLAND = 'ZIMUHCM80693336';

type Row = Record<string, unknown>;
type Container = Row & { unitPrefix: string; unitNo: string; unitActivities: { unitActivitiesItem: Row[] } };
type Reply = Row & { consgListItem: (Row & { referenceNo: string; referenceType: string; result: Row;
  consDetails: Row & { consContainers: { consContainersItem: Container[] } } })[]; unitListItem: (Container & { result: Row })[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/tracking-${name}.json`, import.meta.url), 'utf8')) as Reply;
const read = (name: string, edit?: (reply: Reply) => void, number = name) => {
  const reply = fixture(name);
  edit?.(reply);
  const result = zimResult(reply, zimQuery(number));
  return { ...result, events: result.events ?? [] };
};
const rows = (result: ReturnType<typeof read>) =>
  result.events.map(event => [event.time ?? event.local_time, event.provider_code, event.description, event.location, event.stage ?? null]);
const container = (reply: Reply, index = 0) => reply.consgListItem[0]!.consDetails.consContainers.consContainersItem[index]!;
const activities = (reply: Reply, index = 0) => container(reply, index).unitActivities.unitActivitiesItem;
// ZIM's answers for a number it does not hold, for each kind it looks up.
const missingBill = (number: string) => ({ consgListItem: [{ referenceNo: number, referenceType: 'ER', consDetails: {},
  result: { returnCode: '-1', returnMessage: 'No route legs' } }], isSuccess: true, isServerTimeOut: false });
const missingContainer = (number: string) => ({ unitListItem: [{ unitPrefix: number.slice(0, 4), unitNo: number.slice(4),
  cycleStatusDesc: 'No cycle data found', result: { returnCode: '0', returnMessage: 'Not found Consignment' } }], isSuccess: true, isServerTimeOut: false });

const JACKSONVILLE = 'JACKSONVILLE (FL), US';
const PUSAN = 'PUSAN, KR';

describe('ZIM tracking replies', () => {
  it('reads a bill\'s container activities newest first, at the offset ZIM states for each place', () => {
    const result = read(BILL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty container gate in by Truck', last_update: '2026-07-27T14:27:00-04:00', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-07-27T14:27:00-04:00', 'INME', 'Empty container gate in by Truck', JACKSONVILLE, 'delivered'],
      ['2026-07-24T14:42:00-04:00', 'OICF', 'Import truck departure from Port of Discharge to Customer', JACKSONVILLE, 'out_for_delivery'],
      ['2026-07-20T11:44:00-04:00', 'AVLB', 'Container is available to be released / delivered', JACKSONVILLE, 'ready_for_pickup'],
      ['2026-07-20T11:44:00-04:00', 'DISF', 'Container was discharged at Port of Destination', JACKSONVILLE, 'in_transit'],
      ['2026-07-20T04:26:35-04:00', 'CNT_VESSEL_ARRIVAL', 'Vessel arrival to Port of Discharge', JACKSONVILLE, 'in_transit'],
      ['2026-07-15T17:31:29-04:00', 'CNT_CURL', 'Customs release', JACKSONVILLE, null],
      ['2026-07-13T15:26:27-04:00', 'CNT_CARL', 'Carrier Release', 'MIAMI (FL), US', null],
      ['2026-06-20T05:51:08+09:00', 'CNT_VESSEL_DEPARTURE', 'Vessel departure from Port of Loading to Port of Discharge', PUSAN, 'in_transit'],
      ['2026-06-19T09:37:00+09:00', 'LODF', 'Container was loaded at Port of Loading to Port of Discharge', PUSAN, 'in_transit'],
      ['2026-06-08T14:00:00+09:00', 'IEXF', 'Export gate-in from Customer to Port of Loading', PUSAN, 'accepted'],
      ['2026-06-06T08:59:00+09:00', 'OCLE', 'Empty container dispatched from inland point to Customer', PUSAN, 'registered'],
    ]);
    expect(result.events[0]).toEqual({ time: '2026-07-27T14:27:00-04:00', location: JACKSONVILLE, description: 'Empty container gate in by Truck',
      provider_code: 'INME', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads a container taken out for delivery, an inland leg, and a gate in after the container moved as transit', () => {
    expect(read(TAKEN_OUT)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Import truck departure from Port of Discharge to Customer', last_update: '2026-11-16T15:51:00-05:00' });
    expect(read('ZIMUSHH32333816')).toMatchObject({ status: 'delivered', last_update: '2026-11-18T14:06:00-05:00' });
    const inland = read(INLAND);
    expect(inland).toMatchObject({ status: 'out_for_delivery', last_update: '2026-11-19T16:11:00-05:00' });
    expect(rows(inland).slice(-5)).toEqual([
      ['2026-10-05T02:34:00+07:00', 'LODF', 'Container was loaded at Port of Loading to Port of Discharge', 'CAI MEP, VN', 'in_transit'],
      ['2026-09-29T22:24:00+07:00', 'IEXF', 'Export Gate-In to Port of Loading', 'CAI MEP, VN', 'in_transit'],
      ['2026-09-29T08:42:00+07:00', 'OEXF', 'Export Gate-Out from intermediate point', 'ICD BINH DUONG TERMINAL, VN', 'in_transit'],
      ['2026-09-28T22:49:00+07:00', 'IEXF', 'Export Gate-In from Customer to inland point', 'ICD BINH DUONG TERMINAL, VN', 'accepted'],
      ['2026-09-28T12:36:00+07:00', 'OCLE', 'Empty container dispatched from inland point to Customer', 'HO CHI MINH CITY, VN', 'registered'],
    ]);
  });

  it('reads a container\'s own lookup as its bill\'s, its wall clocks in their place\'s zone', () => {
    const moves = (result: ReturnType<typeof read>) => result.events.map(event => `${event.time} ${event.provider_code} ${event.location}`).sort();
    const container = read(CONTAINER);
    expect(moves(container)).toEqual(moves(read(TAKEN_OUT)));
    expect(container).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-11-16T15:51:00-05:00' });
    // The container's reply labels this arrival +03:00; its bill's states Savannah's -05:00.
    expect(container.events.find(event => event.provider_code === 'CNT_VESSEL_ARRIVAL')).toEqual({ time: '2026-11-12T11:06:23-05:00',
      local_time: '2026-11-12T11:06:23', time_zone: 'America/New_York', time_zone_basis: 'place', location: 'SAVANNAH (GA), US',
      description: 'Vessel arrival to Port of Discharge', provider_code: 'CNT_VESSEL_ARRIVAL', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(container.events.find(event => event.provider_code === 'CNT_VESSEL_DEPARTURE')).toMatchObject({ time: '2026-10-06T14:54:00+08:00',
      time_zone: 'Asia/Shanghai' });
  });

  it('delivers a bill only once every container is returned empty, and keeps the activities its containers share once', () => {
    const second = (reply: Reply, keep: (moves: Row[]) => Row[]) => {
      container(reply).unitActivities.unitActivitiesItem = activities(reply);
      reply.consgListItem[0]!.consDetails.consContainers.consContainersItem.push({ ...container(reply), unitPrefix: 'ZZZU', unitNo: '9999992',
        unitActivities: { unitActivitiesItem: keep(activities(reply)) } });
    };
    const waiting = read(RETURNED, reply => second(reply, moves => moves.slice(0, -1)));
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Empty container gate in by Truck' });
    expect(waiting.events).toEqual(read(RETURNED).events);
    const unmoved = read(RETURNED, reply => second(reply, moves => moves.filter(move => move.activityCode === 'CNT_CARL')));
    expect(unmoved).toMatchObject({ status: 'unknown', last_update: '2026-11-17T06:46:00-05:00' });
    expect(unmoved).not.toHaveProperty('current_stage');
    expect(read(RETURNED, reply => second(reply, moves => moves))).toEqual(read(RETURNED));
  });

  it('reads an empty container returned before it moved as no delivery, and a time ZIM states without an offset in its place\'s zone', () => {
    const unused = read(BILL, reply => {
      container(reply).unitActivities.unitActivitiesItem = [activities(reply)[0]!, { ...activities(reply).at(-1)!, activityDateTz: '2026-06-09T10:00:00+09:00' }];
    });
    expect(unused).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Empty container gate in by Truck' });
    expect(unused.events[0]).not.toHaveProperty('stage');
    const unstated = read(BILL, reply => { delete activities(reply).at(-1)!.activityDateTz; });
    expect(unstated).toMatchObject({ last_update: '2026-07-27T14:27:00-04:00', last_status_text: 'Empty container gate in by Truck' });
    expect(unstated.events[0]).toMatchObject({ local_time: '2026-07-27T14:27:00', time_zone: 'America/New_York', time_zone_basis: 'place' });
    const unplaced = read(BILL, reply => {
      Object.assign(activities(reply).at(-1)!, { placeFromDesc: 'SYNTHETIC', countryFromCode: 'CA' });
      delete activities(reply).at(-1)!.activityDateTz;
    });
    expect(unplaced).toMatchObject({ last_update: null, last_update_local: '2026-07-27T14:27:00', last_status_text: 'Empty container gate in by Truck' });
    expect(unplaced.events[0]).not.toHaveProperty('time');
  });

  it('answers no history for a shipment ZIM lists without activities', () => {
    for (const edit of [(reply: Reply) => { container(reply).unitActivities.unitActivitiesItem = []; },
      (reply: Reply) => { reply.consgListItem[0]!.consDetails = {} as never; }]) {
      expect(() => read(BILL, edit)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    }
  });

  it('reads ZIM\'s answer for a number it does not hold only for the kind looked up', () => {
    expect(() => zimResult(missingBill(BILL), zimQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => zimResult(missingContainer(CONTAINER), zimQuery(CONTAINER))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => zimResult(missingContainer(CONTAINER), zimQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => zimResult(missingBill(CONTAINER), zimQuery(CONTAINER))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => zimResult({ ...missingBill(BILL), isServerTimeOut: true }, zimQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads Akamai\'s refusal and its check as a challenge, and other pages as a changed reply', () => {
    for (const body of ['<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.0</BODY></HTML>',
      '<!DOCTYPE html><html><head><title>Challenge Validation</title></head><body></body></html>']) {
      expect(() => zimReplyText(body, zimQuery(BILL)), body).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    for (const body of ['', '<html><body>Maintenance</body></html>', '{"isSuccess":true']) {
      expect(() => zimReplyText(body, zimQuery(BILL)), body).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(zimReplyText(`\uFEFF${JSON.stringify(fixture(BILL))}`, zimQuery(BILL))).toMatchObject({ last_update: '2026-07-27T14:27:00-04:00' });
  });

  it('refuses a reply for another number or another kind of lookup, and a changed one', () => {
    const fails = (name: string, edit: (reply: Reply) => void) => expect(() => read(name, edit)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(BILL, reply => { reply.consgListItem[0]!.referenceNo = 'ZIMUSEL71213499'; });
    fails(BILL, reply => { reply.consgListItem[0]!.referenceType = 'BK'; });
    fails(BILL, reply => { reply.consgListItem[0]!.result = { returnCode: '0', returnMessage: 'Not found Consignment' }; });
    fails(BILL, reply => { reply.consgListItem.push(reply.consgListItem[0]!); });
    fails(BILL, reply => { reply.consgListItem = []; });
    fails(BILL, reply => { reply.isSuccess = false; });
    fails(BILL, reply => { container(reply).unitPrefix = 'ZZZ'; });
    fails(BILL, reply => { container(reply).unitActivities = { unitActivitiesItem: {} as never }; });
    fails(BILL, reply => { activities(reply)[0]!.activityDateTz = '2026-02-31T08:59:00+09:00'; });
    fails(BILL, reply => { activities(reply)[0]!.activityDateTz = '1999-06-06T08:59:00+09:00'; });
    fails(BILL, reply => { activities(reply)[0]!.activityDateTz = '2026-06-06T24:59:00+09:00'; });
    fails(BILL, reply => { activities(reply)[0]!.activityDateTz = '2026-06-06 08:59'; });
    fails(BILL, reply => { delete activities(reply)[0]!.activityDateTz; delete activities(reply)[0]!.activityDate; });
    fails(BILL, reply => { activities(reply)[0]!.activityCode = 'ocle'; });
    fails(BILL, reply => { activities(reply)[0]!.activityDesc = ' '; });
    fails(BILL, reply => { activities(reply)[0]!.countryFromCode = 'KOR'; });
    fails(BILL, reply => { activities(reply)[0]!.placeFromDesc = 7; });
    fails(CONTAINER, reply => { reply.unitListItem[0]!.unitNo = '2975218'; });
    fails(CONTAINER, reply => { reply.unitListItem.push(reply.unitListItem[0]!); });
    fails(CONTAINER, reply => { reply.unitListItem[0]!.result = { returnCode: '-1' }; });
    expect(() => zimResult([], zimQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => zimResult(fixture(BILL), zimQuery(CONTAINER))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => zimResult(fixture(CONTAINER), zimQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });
});

const ok = (name: string) => new Response(JSON.stringify(fixture(name)), { status: 200, headers: { 'content-type': 'application/json' } });
const carrier = (fetcher: typeof fetch, browserExecutablePath: string | null = '/synthetic/chromium', recorder: StepRecorder = NOOP_RECORDER) =>
  adapter({ fetcher, recorder, env: {}, trawl: null, browserExecutablePath });

describe('ZIM adapter', () => {
  it('takes a bill with or without ZIMU, or a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('TCNU297521'), containerCheckDigit('ZZZU999999')]).toEqual([7, 2]);
    expect(zimQuery(' zimu shh 3234-0236 ')).toEqual({ kind: 'bill', number: TAKEN_OUT });
    expect(zimQuery('SHH32340236')).toEqual({ kind: 'bill', number: TAKEN_OUT });
    expect(zimQuery('tcnu 297521-7')).toEqual({ kind: 'container', number: CONTAINER });
    expect(zimLookupUrl(zimQuery(BILL)))
      .toBe(`https://apigw.zim.com/digital/TrackShipment/v2/complete-result?reference=${BILL}&subscription-key=${ZIM_SUBSCRIPTION_KEY}`);
    expect(zimPageUrl(zimQuery(CONTAINER))).toBe(`https://www.zim.com/tools/track-a-shipment?consnumber=${CONTAINER}`);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TCNU2975218', 'ZIMU1234', 'SH32340236', 'ZIMUSHH123456', 'ABCDEFGHI', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks for the number as the tracking page does, with a browser\'s name', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ok(BILL));
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, null, recorder).track({ number: BILL })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(zimLookupUrl(zimQuery(BILL)));
    expect(init).toMatchObject({ method: 'GET' });
    const headers = new Headers(init!.headers);
    expect([headers.get('user-agent'), headers.get('referer')]).toEqual([ZIM_USER_AGENT, 'https://www.zim.com/']);
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
    expect(vi.mocked(fetchZimInBrowser)).not.toHaveBeenCalled();
  });

  it('opens the tracking page in a local browser when Akamai refuses the lookup, and only then', async () => {
    const browser = vi.mocked(fetchZimInBrowser).mockClear().mockResolvedValue(read(BILL));
    await expect(carrier(async () => new Response('<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>', { status: 403 })).track({ number: BILL }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(browser).toHaveBeenCalledWith({ kind: 'bill', number: BILL }, '/synthetic/chromium', expect.any(AbortSignal), expect.any(Number));
    browser.mockClear();
    await expect(carrier(async () => new Response('', { status: 403 }), null).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => new Response(JSON.stringify(missingBill(BILL)))).track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(async () => new Response('', { status: 429 })).track({ number: BILL })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(browser).not.toHaveBeenCalled();
    browser.mockRejectedValue(new ChallengeError('ZIM'));
    await expect(carrier(async () => new Response('', { status: 403 })).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('asks once more when the lookup does not reach ZIM', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(ok(CONTAINER));
    await expect(carrier(fetcher, null).track({ number: CONTAINER })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is asked when the number is filed under ZIM or comes in a link to its tracking page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => ok(BILL));
    await expect(createTracker({ providers: [], env: {}, fetcher }).track({ number: BILL, carrier: 'zim' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'zim', source: 'zim', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('zim').tracking).toMatchObject({ adapter: 'zim', browser: true });
    for (const number of [BILL, CONTAINER]) {
      expect(parseTrackingInput(`https://www.zim.com/tools/track-a-shipment?consnumber=${number}`))
        .toMatchObject({ trackingNumber: number, carrier: 'zim', source: 'link' });
    }
  });
});

describe('ZIM status vocabulary', () => {
  it('stages each code the page gives, and leaves the releases without a stage', () => {
    for (const entry of statuses.entries) {
      expect(zimStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'zim', providerCode: entry.code, description: entry.wording }).kind, entry.code)
        .toBe(entry.stage ? 'mapped' : 'intentional_gap');
    }
    expect(zimStage('OEXP')).toBeUndefined();
    expect(statusMap.stage(null, 'Container was discharged at Port of Destination')).toBeUndefined();
  });
});
