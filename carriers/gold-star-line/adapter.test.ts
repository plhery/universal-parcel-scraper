import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GOLD_STAR_LINE_USER_AGENT } from './adapter.js';
import { fetchGoldStarLineInBrowser } from './browser.js';
import {
  GOLD_STAR_LINE_LOOKUP, goldStarLineLookupBody, goldStarLinePageUrl, goldStarLineQuery, goldStarLineReplyText, goldStarLineResult,
} from './parser.js';
import { goldStarLineStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

vi.mock('./browser.js', () => ({ fetchGoldStarLineInBrowser: vi.fn() }));

// The public samples: four containers and two bills. Other numbers are synthetic.
const OWN = 'GOSU1029960';
const YANTIAN = 'GSLU2051127';
const SAILING = 'JXLU6490287';
const SAVANNAH = 'UETU2904518';
const BILL = 'GOSUSHH003860672';
const OLD_BILL = 'GOSUPAV6038932';
const UNKNOWN = 'GOSU0000010';

type Row = Record<string, unknown>;
type Activity = Row & { activityDateTz: Row & { dateTime: unknown; offsetMinutes: unknown }; activityDesc: unknown; placeFromDesc: unknown;
  countryFromName: unknown };
type Container = Row & { unitPrefix: string; unitNo: string; unitActivityList?: Activity[] };
type Reply = Row & { status: string; data: Row & { status: number; message: Row & { containerid: string; response: Row & {
  statusCode?: unknown; message?: unknown; consignmentDetails: Row & { type: string; consContainerList: Container[] } } } } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const tracking = (name: string) => fixture(`tracking-${name}`);
const read = (name: string, edit?: (reply: Reply) => void, number = name) => {
  const reply = tracking(name);
  edit?.(reply);
  const result = goldStarLineResult(reply, goldStarLineQuery(number));
  return { ...result, events: result.events ?? [] };
};
const rows = (result: ReturnType<typeof read>) =>
  result.events.map(event => [event.time ?? event.local_time, event.description, event.location, event.stage ?? null]);
const containers = (reply: Reply) => reply.data.message.response.consignmentDetails.consContainerList;
const activities = (reply: Reply, index = 0) => containers(reply)[index]!.unitActivityList!;
const unknown = (edit?: (reply: Reply) => void) => {
  const reply = fixture(`not-found-${UNKNOWN}`);
  edit?.(reply);
  return reply;
};
const schema = expect.objectContaining({ kind: 'schema' });

const SIHANOUKVILLE = 'SIHANOUKVILLE (KOMPONG SOM), KH';
const GA = 'SAVANNAH (GA), US';

describe('Gold Star Line tracking replies', () => {
  it('reads a container\'s activities newest first, at the offset stated for each place, named by the reply\'s ports', () => {
    const result = read(OWN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty container gate in', last_update: '2026-10-21T19:19:00+07:00', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-10-21T19:19:00+07:00', 'Empty container gate in', SIHANOUKVILLE, 'delivered'],
      ['2026-10-21T10:11:00+07:00', 'Import Gate-Out from Port of Discharge to Customer', SIHANOUKVILLE, 'out_for_delivery'],
      ['2026-10-17T17:21:00+07:00', 'Barge was discharged at Port of Discharge', SIHANOUKVILLE, 'in_transit'],
      ['2026-10-15T16:30:00+08:00', 'Barge was loaded at Port of Loading to Port of Discharge', 'SINGAPORE, SG', 'in_transit'],
      ['2026-10-14T13:23:00+08:00', 'Export gate-in from Customer to Port of Loading', 'SINGAPORE, SG', 'accepted'],
      ['2026-10-08T12:56:00+08:00', 'Empty container dispatched from inland point to Customer', 'SINGAPORE, SG', 'registered'],
    ]);
    expect(result.events[0]).toEqual({ time: '2026-10-21T19:19:00+07:00', location: SIHANOUKVILLE, description: 'Empty container gate in',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(read(YANTIAN)).toMatchObject({ status: 'delivered', last_update: '2026-11-02T08:11:00+08:00',
      events: expect.arrayContaining([expect.objectContaining({ location: 'YANTIAN (GD), CN', description: 'Empty container gate in' })]) });
    expect(read(SAILING)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-11-04T11:22:00+08:00',
      last_status_text: 'Container was loaded at Transsihipment Port to Port of Discharge' });
  });

  it('reads the releases ZIM labels +03:00 on their place\'s wall clock, and orders activities of one time by stage', () => {
    const result = read(SAVANNAH);
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Empty container gate in by Truck', last_update: '2026-10-14T09:18:00-04:00' });
    expect(rows(result)).toEqual([
      ['2026-10-14T09:18:00-04:00', 'Empty container gate in by Truck', GA, 'delivered'],
      ['2026-10-12T13:41:00-04:00', 'Import truck departure from Port of Discharge to Customer', GA, 'out_for_delivery'],
      ['2026-10-06T22:36:00-04:00', 'Container is available to be released / delivered', GA, 'ready_for_pickup'],
      ['2026-10-06T22:36:00-04:00', 'Container was discharged at Port of Destination', GA, 'in_transit'],
      ['2026-10-02T16:01:29-04:00', 'Customs release', GA, null],
      ['2026-08-21T19:46:00+08:00', 'Container was loaded at Transsihipment Port to Port of Discharge', 'SINGAPORE, SG', 'in_transit'],
      ['2026-08-20T10:52:41-04:00', 'Carrier Release', GA, null],
      ['2026-08-20T00:53:00+08:00', 'Container was discharged at Transshipment Port', 'SINGAPORE, SG', 'in_transit'],
      ['2026-08-17T03:06:00+07:00', 'Container was loaded at Port of Loading to Transshipment Port', 'JAKARTA, ID', 'in_transit'],
      ['2026-08-12T20:42:00+07:00', 'Export gate-in from Customer to Port of Loading', 'JAKARTA, ID', 'accepted'],
      ['2026-08-11T21:03:00+07:00', 'Empty container dispatched from inland point to Customer', 'JAKARTA, ID', 'registered'],
    ]);
    expect(result.events[6]).toEqual({ time: '2026-08-20T10:52:41-04:00', local_time: '2026-08-20T10:52:41', time_zone: 'America/New_York',
      time_zone_basis: 'place', location: GA, description: 'Carrier Release' });
    // Indonesia keeps several zones: a label there leaves the wall clock alone.
    const jakarta = read(SAVANNAH, reply => {
      activities(reply).find(move => String(move.activityDesc).startsWith('Empty container dispatched'))!.activityDateTz.offsetMinutes = 180;
    });
    expect(jakarta.events.filter(event => event.location === 'JAKARTA, ID').map(event => event.time ?? `${event.local_time} wall`)).toEqual([
      '2026-08-17T03:06:00+07:00', '2026-08-12T20:42:00+07:00', '2026-08-11T21:03:00 wall']);
    const nowhere = read(OWN, reply => { Object.assign(activities(reply)[3]!, { countryFromName: 'NOWHERE', placeFromDesc: 'SYNTHETIC',
      activityDateTz: { dateTime: '2026-10-22T08:00:00', offsetMinutes: 180 } }); });
    expect(nowhere).toMatchObject({ last_update: null, last_update_local: '2026-10-22T08:00:00', last_status_text: 'Empty container gate in' });
    expect(nowhere.events[0]).toEqual({ local_time: '2026-10-22T08:00:00', location: 'SYNTHETIC, NOWHERE', description: 'Empty container gate in',
      stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads an empty container returned before it moved as no delivery, and a gate in after it moved as transit', () => {
    const move = (reply: Reply, wording: string) => activities(reply).find(activity => String(activity.activityDesc).startsWith(wording))!;
    const unused = read(OWN, reply => {
      containers(reply)[0]!.unitActivityList = [move(reply, 'Empty container dispatched'),
        { ...move(reply, 'Empty container gate in'), activityDateTz: { dateTime: '2026-10-09T08:00:00', offsetMinutes: 480 } }];
    });
    expect(unused).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Empty container gate in' });
    expect(unused.events[0]).not.toHaveProperty('stage');
    const inland = read(OWN, reply => { move(reply, 'Export gate-in').activityDateTz = { dateTime: '2026-10-15T18:00:00', offsetMinutes: 480 }; });
    expect(rows(inland).at(-3)).toEqual(['2026-10-15T18:00:00+08:00', 'Export gate-in from Customer to Port of Loading', 'SINGAPORE, SG', 'in_transit']);
  });

  it('delivers a bill only once every container is returned empty, and keeps the activities its containers share once', () => {
    const bill = (...units: Container[]) => read(BILL, reply => { reply.data.message.response.consignmentDetails.consContainerList = units; });
    const own = containers(tracking(OWN))[0]!;
    const sailing = containers(tracking(SAILING))[0]!;
    const returned = containers(tracking(YANTIAN))[0]!;
    expect(bill(own, sailing)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Container was loaded at Transsihipment Port to Port of Discharge' });
    expect(bill(own, returned)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-11-02T08:11:00+08:00' });
    expect(bill(own, { ...own, unitPrefix: 'ZZZU', unitNo: '9999992' }).events).toEqual(bill(own).events);
    const waiting = bill(own, { unitPrefix: 'ZZZU', unitNo: '9999992 ' });
    expect(waiting).toMatchObject({ status: 'unknown', last_status_text: 'Empty container gate in' });
    expect(waiting).not.toHaveProperty('current_stage');
    expect(bill(own).events.map(event => event.location)).toContain('SIHANOUKVILLE (KOMPONG SOM), CAMBODIA KAMPUCHEA');
  });

  it('answers no history for a shipment Gold Star Line lists without activities', () => {
    const listed = expect.objectContaining({ kind: 'indeterminate', reason: 'listed' });
    expect(() => read(BILL)).toThrowError(listed);
    expect(() => read(OLD_BILL)).toThrowError(listed);
    expect(() => read(BILL, reply => { reply.data.message.response.consignmentDetails.consContainerList = []; })).toThrowError(listed);
    expect(() => read(OWN, reply => { containers(reply)[0]!.unitActivityList = []; })).toThrowError(listed);
  });

  it('reads not found only for the number asked, and the internal errors behind the page by their status', () => {
    expect(() => goldStarLineResult(unknown(), goldStarLineQuery(UNKNOWN))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => goldStarLineResult(unknown(reply => { reply.data.message.containerid = 'GOSUABC1234567'; }), goldStarLineQuery('ABC1234567')))
      .toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => goldStarLineResult(unknown(), goldStarLineQuery(OWN))).toThrowError(schema);
    expect(() => goldStarLineResult(unknown(reply => { reply.data.message.response.message = 'reference not valid'; }), goldStarLineQuery(UNKNOWN)))
      .toThrowError(schema);
    const failing = (statusCode: unknown) => unknown(reply => {
      reply.data.message.response = { statusCode, message: 'The request could not be processed due to an internal error. Contact the API owner.' } as never;
    });
    for (const [code, kind] of [[502, 'indeterminate'], ['504', 'indeterminate'], [503, 'maintenance'], [429, 'rate_limited'], [404, 'schema'],
      ['GSL-0001', 'schema'], [null, 'schema']] as const) {
      expect(() => goldStarLineResult(failing(code), goldStarLineQuery(UNKNOWN)), String(code)).toThrowError(expect.objectContaining({ kind }));
    }
  });

  it('reads Akamai\'s refusal as a challenge, and other pages as a changed reply', () => {
    for (const body of ['<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.0</BODY></HTML>',
      '<!DOCTYPE html><html><head><title>Challenge Validation</title></head><body></body></html>']) {
      expect(() => goldStarLineReplyText(body, goldStarLineQuery(OWN)), body).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    for (const body of ['', '<html><body>Maintenance</body></html>', '{"status":"OK"']) {
      expect(() => goldStarLineReplyText(body, goldStarLineQuery(OWN)), body).toThrowError(schema);
    }
    expect(goldStarLineReplyText(`\uFEFF${JSON.stringify(tracking(OWN))}`, goldStarLineQuery(OWN))).toMatchObject({ last_update: '2026-10-21T19:19:00+07:00' });
  });

  it('refuses a reply for another number or another kind of lookup, and a changed one', () => {
    const fails = (name: string, edit: (reply: Reply) => void) => expect(() => read(name, edit)).toThrowError(schema);
    fails(OWN, reply => { reply.status = 'ERROR'; });
    fails(OWN, reply => { reply.data.status = 2; });
    fails(OWN, reply => { reply.data.message.containerid = 'GOSU1029961'; });
    fails(OWN, reply => { reply.data.message.response.consignmentDetails.type = 'BL'; });
    fails(OWN, reply => { containers(reply).push(containers(reply)[0]!); });
    fails(OWN, reply => { containers(reply)[0]!.unitNo = '1029961 '; });
    fails(OWN, reply => { containers(reply)[0]!.unitPrefix = 'GOS'; });
    fails(OWN, reply => { containers(reply)[0]!.unitActivityList = {} as never; });
    fails(OWN, reply => { reply.data.message.response.consignmentDetails = [] as never; });
    for (const dateTime of ['2026-02-31T08:59:00', '1999-10-08T12:56:00', '2026-10-08T24:00:00', '2026-10-08 12:56', '2026-10-08T12:56:00+08:00', null]) {
      fails(OWN, reply => { activities(reply)[0]!.activityDateTz.dateTime = dateTime; });
    }
    for (const offsetMinutes of ['480', 1.5, 900, null]) fails(OWN, reply => { activities(reply)[0]!.activityDateTz.offsetMinutes = offsetMinutes; });
    fails(OWN, reply => { activities(reply)[0]!.activityDateTz = null as never; });
    fails(OWN, reply => { activities(reply)[0]!.activityDesc = ' '; });
    fails(OWN, reply => { activities(reply)[0]!.placeFromDesc = 7; });
    fails(BILL, reply => { reply.data.message.response.consignmentDetails.type = 'Container'; });
    expect(() => goldStarLineResult([], goldStarLineQuery(OWN))).toThrowError(schema);
    expect(() => goldStarLineResult(tracking(BILL), goldStarLineQuery(OWN))).toThrowError(schema);
    expect(() => goldStarLineResult(tracking(OWN), goldStarLineQuery(BILL))).toThrowError(schema);
  });
});

const ok = (name: string) => new Response(JSON.stringify(tracking(name)), { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch, browserExecutablePath: string | null = '/synthetic/chromium', recorder: StepRecorder = NOOP_RECORDER) =>
  adapter({ fetcher, recorder, env: {}, trawl: null, browserExecutablePath });
const DENIED = '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>';

describe('Gold Star Line adapter', () => {
  it('takes a bill with or without GOSU, or a container with its check digit, and nothing else', async () => {
    expect(goldStarLineQuery(' gosu shh 0038-60672 ')).toEqual({ kind: 'bill', number: BILL });
    expect(goldStarLineQuery('PAV6038932')).toEqual({ kind: 'bill', number: OLD_BILL });
    expect(goldStarLineQuery('gosu 102996-0')).toEqual({ kind: 'container', number: OWN });
    expect(goldStarLinePageUrl(goldStarLineQuery(OWN))).toBe(`https://www.goldstarline.com/tools/track_shipment/${OWN}`);
    expect(goldStarLineLookupBody(goldStarLineQuery(OWN))).toBe(`{"action":"get_track_shipment_val","country_code":"HK","containerid":"${OWN}"}`);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['GOSU1029961', 'GOSU1234', 'SH003860672', 'GOSUSHH123456', 'ABCDEFGHI', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: OWN }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts the lookup as the tracking page does, with a browser\'s name', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ok(OWN));
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, null, recorder).track({ number: OWN })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(GOLD_STAR_LINE_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', body: goldStarLineLookupBody(goldStarLineQuery(OWN)) });
    const headers = new Headers(init!.headers);
    expect([headers.get('user-agent'), headers.get('content-type'), headers.get('origin'), headers.get('referer')]).toEqual([
      GOLD_STAR_LINE_USER_AGENT, 'text/plain;charset=UTF-8', 'https://www.goldstarline.com', `https://www.goldstarline.com/tools/track_shipment/${OWN}`]);
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
    expect(vi.mocked(fetchGoldStarLineInBrowser)).not.toHaveBeenCalled();
  });

  it('opens the tracking page in a local browser when Akamai refuses the lookup, and only then', async () => {
    const browser = vi.mocked(fetchGoldStarLineInBrowser).mockClear().mockResolvedValue(read(OWN));
    for (const refusal of [() => new Response(DENIED, { status: 403 }), () => new Response(DENIED, { status: 200 })]) {
      await expect(carrier(async () => refusal()).track({ number: OWN })).resolves.toMatchObject({ current_stage: 'delivered' });
    }
    expect(browser).toHaveBeenCalledWith({ kind: 'container', number: OWN }, '/synthetic/chromium', expect.any(AbortSignal), expect.any(Number));
    browser.mockClear();
    await expect(carrier(async () => new Response('', { status: 403 }), null).track({ number: OWN })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => new Response(JSON.stringify(unknown()))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(async () => new Response('', { status: 429 })).track({ number: OWN })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(async () => new Response('<html></html>')).track({ number: OWN })).rejects.toMatchObject({ kind: 'schema' });
    expect(browser).not.toHaveBeenCalled();
    browser.mockRejectedValue(new ChallengeError('Gold Star Line'));
    await expect(carrier(async () => new Response('', { status: 403 })).track({ number: OWN })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('asks once more when the lookup does not reach Gold Star Line', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(ok(SAVANNAH));
    await expect(carrier(fetcher, null).track({ number: SAVANNAH })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is asked when the number is filed under Gold Star Line or comes in a link to its tracking page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => ok(OWN));
    await expect(createTracker({ providers: [], env: {}, fetcher }).track({ number: OWN, carrier: 'gold-star-line' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gold-star-line', source: 'gold-star-line', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('gold-star-line').tracking).toMatchObject({ adapter: 'gold-star-line', browser: true, localClocks: true });
    for (const link of [`https://www.goldstarline.com/tools/track_shipment/${OWN}`,
      `https://www.goldstarline.com/CCM.aspx?hidSearch=true&hidFromHomePage=false&hidSearchType=1&id=166&l=4&textContainerNumber=${OLD_BILL}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: link.endsWith(OWN) ? OWN : OLD_BILL, carrier: 'gold-star-line', source: 'link' });
    }
  });
});

describe('Gold Star Line status vocabulary', () => {
  it('stages each wording the page gives, and leaves the releases without a stage', () => {
    for (const entry of statuses.entries) {
      expect(goldStarLineStage(` ${entry.wording.toUpperCase()} `), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'gold-star-line', description: entry.wording }).kind, entry.wording)
        .toBe(entry.stage ? 'mapped' : 'intentional_gap');
    }
    expect(goldStarLineStage('Vessel departure')).toBeUndefined();
    expect(statusMap.stage('LODF', 'container was loaded at port of loading to port of discharge')).toBeUndefined();
  });
});
