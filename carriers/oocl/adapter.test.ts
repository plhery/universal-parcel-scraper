import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { fetchOoclInBrowser } from './browser.js';
import { containerCheckDigit, decryptOoclReply, OOCL_REPLY_KEY, ooclLinkUrl, ooclLookups, ooclQuery, ooclResult, type OoclLookup } from './parser.js';
import { ooclStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

vi.mock('./browser.js', () => ({ fetchOoclInBrowser: vi.fn() }));

// The public samples are bills of lading and a container of the first; the other numbers are synthetic and lie far beyond the ranges in use.
const BILL = '2333970780';
const CONTAINER = 'OOLU9708580';
const TAIWAN = '2328458870';
const RAIL = '2337137160';
const FEEDER = '2173257310';

type Row = Record<string, unknown>;
type Summary = Row & { containerList: (Row & { milestoneEventList: Row[] })[]; routes: (Row & { vesselInfo: Row | null })[] };
type Reply = { code: string; message: null; success: boolean; result: Row & { summaryList: Summary[] } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/summary-${name}.json`, import.meta.url), 'utf8')) as Reply;
const read = (name: string, lookup: OoclLookup = 'blNumber', edit?: (reply: Reply) => void) => {
  const reply = fixture(name);
  edit?.(reply);
  return ooclResult(reply, ooclQuery(name), lookup);
};
/** A reply as OOCL sends it: AES-GCM under the page's key, a nonce first, in base64, as a JSON string. */
async function encrypt(value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(OOCL_REPLY_KEY), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))));
  return JSON.stringify(Buffer.concat([iv, sealed]).toString('base64'));
}
const carrier = (browserExecutablePath: string | null = '/synthetic/chromium', recorder: StepRecorder = NOOP_RECORDER) =>
  adapter({ recorder, env: {}, trawl: null, browserExecutablePath });
const rows = (result: ReturnType<typeof read>) => result!.events!.map(event => [event.time, event.provider_code, event.location, event.stage]);

describe('OOCL cargo tracking replies', () => {
  it('reads every milestone of a bill\'s containers, newest first, on the clocks OOCL names', () => {
    const result = read(BILL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty Return', last_update: '2026-11-06T12:48:00-05:00', expected_delivery: null });
    expect(result).not.toHaveProperty('planned_events');
    expect(rows(result)).toEqual([
      ['2026-11-06T12:48:00-05:00', 'Empty Return (Inbound)', 'Conley Terminal, Boston, Massachusetts, United States', 'delivered'],
      ['2026-10-23T13:27:00-04:00', 'Gate Out (Inbound)', 'Conley Terminal, Boston, Massachusetts, United States', 'out_for_delivery'],
      ['2026-10-18T22:48:00-04:00', 'Discharged (Ocean)', 'Conley Terminal, Boston', 'in_transit'],
      ['2026-10-17T21:06:00-04:00', 'Arrival (Ocean)', 'Conley Terminal, Boston', 'in_transit'],
      ['2026-09-04T05:29:00+08:00', 'Departure (Ocean)', 'Shanghai Shengdong Intl Cntr Tmnl - (Yangshan), Shanghai', 'in_transit'],
      ['2026-09-03T13:20:00+08:00', 'Loaded (Ocean)', 'Shanghai Shengdong Intl Cntr Tmnl - (Yangshan), Shanghai', 'in_transit'],
      ['2026-08-29T04:44:00+08:00', 'Discharged (Ocean)', 'Shanghai Shengdong Intl Cntr Tmnl - (Yangshan), Shanghai', 'in_transit'],
      ['2026-08-28T19:33:00+08:00', 'Arrival (Ocean)', 'Shanghai Shengdong Intl Cntr Tmnl - (Yangshan), Shanghai', 'in_transit'],
      ['2026-08-07T06:19:00+07:00', 'Departure (Ocean)', 'Hutchison Laemchabang Terminal Limited, Laem Chabang', 'in_transit'],
      ['2026-08-06T13:44:00+07:00', 'Loaded (Ocean)', 'Hutchison Laemchabang Terminal Limited, Laem Chabang', 'in_transit'],
      ['2026-08-03T02:18:00+07:00', 'Gate In (Outbound)', 'Hutchison Laemchabang Terminal Limited, Laem Chabang, Chon Buri, Thailand', 'accepted'],
      ['2026-07-31T17:23:00+07:00', 'Empty Pick Up (Outbound)', 'MPJ Distribution Center Co., Ltd., Laem Chabang, Chon Buri, Thailand', 'registered'],
    ]);
    expect(result!.events![0]).toEqual({ time: '2026-11-06T12:48:00-05:00', location: 'Conley Terminal, Boston, Massachusetts, United States',
      description: 'Empty Return', provider_code: 'Empty Return (Inbound)', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads a container\'s own milestones, and the same booking looked up as a booking', () => {
    expect(read(CONTAINER, 'containerNumber')).toEqual(read(BILL));
    expect(read(BILL, 'bookingNumber', reply => { reply.result.businessNumberType = 'bookingNumber'; })).toEqual(read(BILL));
    const shared = read(CONTAINER, 'containerNumber', reply => {
      const [container] = reply.result.summaryList[0]!.containerList;
      reply.result.summaryList[0]!.containerList = [{ ...container!, containerNumberWithCheckDigit: 'ZZZU9999992',
        milestoneEventList: [{ ...container!.milestoneEventList[0], eventName: 'Gate Out' }] }, container!];
    });
    expect(shared!.events).toHaveLength(12);
  });

  it('reads China\'s clock in Taiwan, which OOCL files under China, and a town without its country by its facility', () => {
    expect(rows(read(TAIWAN)).slice(-5)).toEqual([
      ['2026-06-26T08:01:00+08:00', 'Loaded (Ocean)', 'Kao Ming Container Terminal Corp - Pier 108-111, Kaohsiung', 'in_transit'],
      ['2026-06-23T19:37:00+08:00', 'Arrived (Outbound)', 'Kao Ming Container Terminal Corp - Pier 108-111, Kaohsiung', 'in_transit'],
      ['2026-06-23T15:45:00+08:00', 'Departed (Outbound)', 'China Container Terminal Corp., Tai Chung', 'in_transit'],
      ['2026-06-16T11:29:00+08:00', 'Gate In (Outbound)', 'China Container Terminal Corp., Taichung, Taiwan', 'accepted'],
      ['2026-06-15T08:55:00+08:00', 'Empty Pick Up (Outbound)', 'Chinese Maritime Transport Ltd, Taichung, Taiwan', 'registered'],
    ]);
  });

  it('reads North America\'s central and Pacific clocks across the change of season, and an inland rail leg', () => {
    expect(rows(read(RAIL)).slice(0, 6)).toEqual([
      ['2026-11-18T11:27:00-06:00', 'Empty Return (Inbound)', 'ITI Intermodal - Wilmington, Chicago, Illinois, United States', 'delivered'],
      ['2026-11-17T13:02:00-06:00', 'Gate Out (Inbound)', 'BNSF - Chicago LPC, Chicago, Illinois, United States', 'out_for_delivery'],
      ['2026-11-17T02:54:00-06:00', 'Arrived (Inbound)', 'BNSF - Chicago LPC, Elwood', 'in_transit'],
      ['2026-11-10T21:33:00-08:00', 'Departed (Inbound)', 'Fenix Marine Services Los Angeles, Los Angeles', 'in_transit'],
      ['2026-10-29T16:45:00-07:00', 'Discharged (Ocean)', 'Fenix Marine Services Los Angeles, Los Angeles', 'in_transit'],
      ['2026-10-29T06:43:00-07:00', 'Arrival (Ocean)', 'Fenix Marine Services Los Angeles, Los Angeles', 'in_transit'],
    ]);
    expect(rows(read(FEEDER)).slice(4, 10).map(([time, code, location]) => [time, code, location])).toEqual([
      ['2026-09-01T03:56:00+07:00', 'Departure (Ocean)', 'Tan Cang - Cai Mep Thi Vai Terminal, Ba Ria'],
      ['2026-08-31T14:52:00+07:00', 'Loaded (Ocean)', 'Tan Cang - Cai Mep Thi Vai Terminal, Ba Ria'],
      ['2026-08-30T10:32:00+07:00', 'Discharged (Ocean)', 'Tan Cang - Cai Mep Thi Vai Terminal, Ba Ria'],
      ['2026-08-30T09:25:00+07:00', 'Arrival (Ocean)', 'Tan Cang - Cai Mep Thi Vai Terminal, Ba Ria'],
      ['2026-08-28T09:30:00+07:00', 'Departure (Ocean)', 'Phnom Penh Autonomous Port, Phnom Penh'],
      ['2026-08-28T04:30:00+07:00', 'Loaded (Ocean)', 'Phnom Penh Autonomous Port, Phnom Penh'],
    ]);
  });

  it('reads a clock it cannot name in its country\'s only zone, and keeps the wall clock where the country has several', () => {
    const relabelled = read(BILL, 'blNumber', reply => {
      const events = reply.result.summaryList[0]!.containerList[0]!.milestoneEventList;
      events[0]!.eventDateTime = '06 Nov 2026 12:48 XYZ';
      events.at(-1)!.eventDateTime = '31 Jul 2026 17:23';
    });
    expect(relabelled!.events![0]).toMatchObject({ local_time: '2026-11-06T12:48:00', provider_code: 'Empty Return (Inbound)' });
    expect(relabelled!.events![0]).not.toHaveProperty('time');
    expect(relabelled).toMatchObject({ last_update: null, last_update_local: '2026-11-06T12:48:00' });
    expect(relabelled!.events!.at(-1)).toMatchObject({ time: '2026-07-31T17:23:00+07:00', local_time: '2026-07-31T17:23:00',
      time_zone: 'Asia/Bangkok', time_zone_basis: 'place' });
  });

  it('keeps the vessel calls OOCL still expects as planned steps', () => {
    const sailing = read(BILL, 'blNumber', reply => {
      const [summary] = reply.result.summaryList;
      const events = summary!.containerList[0]!.milestoneEventList;
      summary!.containerList[0]!.milestoneEventList = events.slice(-6);
      for (const route of summary!.routes) {
        if (route.specificLocationType === 'TRANSSHIPMENT') route.vesselInfo = { ...route.vesselInfo, atdLocalDatetime: null };
        if (route.specificLocationType === 'LPOD') route.vesselInfo = { ...route.vesselInfo, ataLocalDatetime: null, atdLocalDatetime: null };
      }
    });
    expect(sailing).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Discharged', last_update: '2026-08-29T04:44:00+08:00' });
    expect(sailing!.planned_events).toEqual([
      { time: '2026-09-04T05:00:00+08:00', description: 'Departure', location: 'Shanghai Shengdong Intl Cntr Tmnl - (Yangshan), Shanghai', stage: 'in_transit' },
      { time: '2026-10-17T14:00:00-04:00', description: 'Arrival', location: 'Conley Terminal, Boston', stage: 'in_transit' },
    ]);
  });

  it('answers null for a number OOCL does not hold, and no history for a shipment without milestones', () => {
    expect(read(BILL, 'blNumber', reply => { reply.result.summaryList = []; })).toBeNull();
    expect(() => read(BILL, 'blNumber', reply => {
      const [summary] = reply.result.summaryList;
      summary!.containerList = [];
      summary!.routes = summary!.routes.map(route => route.vesselInfo ? { ...route, vesselInfo: { ...route.vesselInfo, ataLocalDatetime: null, atdLocalDatetime: null } } : route);
    })).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed', plannedEvents: [
      expect.objectContaining({ description: 'Departure', time: expect.stringMatching(/\+07:00$/) }),
      expect.objectContaining({ description: 'Departure', time: expect.stringMatching(/\+08:00$/) }),
      expect.objectContaining({ description: 'Arrival', time: expect.stringMatching(/-04:00$/) }),
    ] }));
  });

  it('refuses a reply for another number, another shipment or another container, and a changed one', () => {
    const fails = (name: string, lookup: OoclLookup, edit: (reply: Reply) => void) =>
      expect(() => read(name, lookup, edit)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(BILL, 'blNumber', reply => { reply.result.businessNumber = '9999999990'; });
    fails(BILL, 'bookingNumber', () => {});
    fails(BILL, 'blNumber', reply => { reply.result.summaryList[0] = { ...reply.result.summaryList[0]!, bookingNumber: '9999999990', blStatus: {},
      containerList: reply.result.summaryList[0]!.containerList.map(container => ({ ...container, blNumbers: ['9999999990'] })) }; });
    fails(CONTAINER, 'containerNumber', reply => { reply.result.summaryList[0]!.containerList[0]!.containerNumberWithCheckDigit = 'ZZZU9999992'; });
    fails(BILL, 'blNumber', reply => { reply.result.summaryList[0]!.containerList[0]!.milestoneEventList[0]!.eventDateTime = 'yesterday'; });
    fails(BILL, 'blNumber', reply => { reply.result.summaryList[0]!.containerList[0]!.milestoneEventList[0]!.eventDateTime = '31 Feb 2026 10:00 EST'; });
    fails(BILL, 'blNumber', reply => { reply.result.summaryList[0]!.containerList[0]!.milestoneEventList[0]!.eventName = null; });
    fails(BILL, 'blNumber', reply => { reply.result.summaryList[0]!.routes[1]!.vesselInfo!.etdLocalDatetime = '2026-08-07'; });
    fails(BILL, 'blNumber', reply => { reply.result.summaryList = {} as never; });
  });

  it('decrypts a reply as the tracker\'s script does and keeps Cloudflare, a rate limit and an error apart', async () => {
    const reply = fixture(BILL);
    await expect(decryptOoclReply(await encrypt(reply))).resolves.toEqual(reply);
    await expect(decryptOoclReply(JSON.stringify(reply))).resolves.toEqual(reply);
    await expect(decryptOoclReply(await encrypt({ ...reply, code: '429', success: false }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(decryptOoclReply(await encrypt({ ...reply, code: '500', success: false }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(decryptOoclReply(await encrypt([reply]))).rejects.toMatchObject({ kind: 'schema' });
    await expect(decryptOoclReply('"bm90IHNlYWxlZCBieSB0aGUga2V5IGF0IGFsbA=="')).rejects.toMatchObject({ kind: 'schema' });
    await expect(decryptOoclReply('"short"')).rejects.toMatchObject({ kind: 'schema' });
    await expect(decryptOoclReply('<html><head><title>Just a moment...</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(decryptOoclReply('<html><body>OOCL</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });
});

describe('OOCL adapter', () => {
  it('takes a bill or booking of ten digits, after OOLU too, or a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('OOLU970858'), containerCheckDigit('ZZZU999999')]).toEqual([0, 2]);
    expect(ooclQuery(` oolu ${BILL} `)).toEqual({ kind: 'bill', number: BILL });
    expect(ooclQuery('oolu 970858-0')).toEqual({ kind: 'container', number: CONTAINER });
    expect([ooclLookups(ooclQuery(BILL)), ooclLookups(ooclQuery(CONTAINER))]).toEqual([['blNumber', 'bookingNumber'], ['containerNumber']]);
    expect(ooclLinkUrl(BILL, 'blNumber')).toBe(`https://www.oocl.com/Pages/ExpressLink.aspx?eltype=ct&businessType=blNumber&businessNumber=${BILL}&language=en`);
    const browser = vi.mocked(fetchOoclInBrowser).mockClear();
    for (const number of ['OOLU9708581', '233397078', '23339707800', 'COSU2333970780', 'SAMPLETRACKING', '1'.repeat(70)]) {
      await expect(carrier().track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier().track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(browser).not.toHaveBeenCalled();
  });

  it('follows the tracker in a local browser, and asks for one when it has none', async () => {
    const browser = vi.mocked(fetchOoclInBrowser).mockClear().mockResolvedValue(read(BILL)!);
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier('/synthetic/chromium', recorder).track({ number: `OOLU${BILL}` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(browser).toHaveBeenCalledWith({ kind: 'bill', number: BILL }, '/synthetic/chromium', expect.any(AbortSignal), expect.any(Number));
    expect(recorded).toMatchObject([{ step: 'browser', outcome: 'ok' }]);
    browser.mockClear().mockRejectedValue(new NotFoundError('OOCL'));
    await expect(carrier().track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    browser.mockClear();
    await expect(carrier(null).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge', message: expect.stringMatching(/TRACKING_CHROMIUM_PATH/) });
    expect(browser).not.toHaveBeenCalled();
  });

  it('is asked when the number is filed under OOCL', async () => {
    vi.mocked(fetchOoclInBrowser).mockClear().mockResolvedValue(read(BILL)!);
    await expect(createTracker({ providers: [], env: {}, chromiumPath: '/synthetic/chromium' }).track({ number: BILL, carrier: 'oocl' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'oocl', source: 'oocl', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('oocl').tracking).toMatchObject({ adapter: 'oocl', browser: true, localClocks: true });
  });
});

describe('OOCL status vocabulary', () => {
  it('stages each milestone by its name and leg', () => {
    for (const entry of statuses.entries) {
      expect(ooclStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'oocl', providerCode: entry.code, description: entry.wording }).kind, entry.code).toBe('mapped');
    }
    expect(ooclStage('Departed')).toBeUndefined();
    expect(statusMap.stage(null, 'Gate Out')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'oocl', providerCode: 'Transship (Ocean)', description: 'Transship' })).toEqual({ kind: 'unknown' });
  });
});
