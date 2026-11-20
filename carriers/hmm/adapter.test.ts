import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { fetchHmmInBrowser } from './browser.js';
import { containerCheckDigit, hmmQuery, hmmRequestBody, hmmResult, placeZone } from './parser.js';
import { hmmStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

vi.mock('./browser.js', () => ({ fetchHmmInBrowser: vi.fn() }));

// The public samples: four bills of lading, and the containers their replies list. Other numbers are synthetic.
const BILL = 'TSNM63064100';
const CONTAINER = 'HMMU7109170';
const TWO_CONTAINERS = 'SHAZ3PM78800';
const BERTHED = 'NBOM63007200';
const TRANSSHIPPED = 'TAOM77162500';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/tracking-${name}.html`, import.meta.url), 'utf8');
const edited = (name: string, edit: ($: CheerioAPI) => void) => {
  const $ = load(fixture(name));
  edit($);
  return $.html();
};
const read = (name: string, edit?: ($: CheerioAPI) => void, number = name) => {
  const result = hmmResult(edit ? edited(name, edit) : fixture(name), hmmQuery(number));
  return { ...result, events: result.events ?? [] };
};
const rows = (result: ReturnType<typeof read>) =>
  result.events.map(event => [event.time ?? null, event.local_time, event.location, event.description, event.stage ?? null]);
// The cells of a container's row, and of a move's row, by their place in it.
const containerCell = ($: CheerioAPI, row: number, cell: number) => $('#containerStatus tbody tr').eq(row).children('td').eq(cell).find('div.text').first();
const moveCell = ($: CheerioAPI, row: number, cell: number) => $('#shipmentProgress tr.clsMoves').eq(row).children('td').eq(cell).find('div.text');
// HMM's answer for a number it does not hold.
const missing = (label: string) => `<div class="tab-outer" id="trackingInfomationDateResultTable"><input type="hidden" id="searchType" value="" />
<div class="tab-inner"><div class="tab-title-wrap"><div class="tab-title">${label} no. is invalid. Please try again with the correct ${label} no.</div></div></div></div>`;

const OAKLAND = 'OAKLAND, CA';
const BUSAN = 'BUSAN, KOREA';
const XINGANG = 'XINGANG, TIANJIN, CHINA';

describe('HMM tracking replies', () => {
  it('reads the moves of a bill\'s container newest first, with the instant each place\'s clock gives', () => {
    const result = read(BILL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Import Empty Container Returned', last_update: '2026-11-09T13:20:00-08:00', last_update_local: '2026-11-09T13:20:00',
      expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-11-09T13:20:00-08:00', '2026-11-09T13:20:00', OAKLAND, 'Import Empty Container Returned', 'delivered'],
      ['2026-10-23T10:38:00-07:00', '2026-10-23T10:38:00', OAKLAND, 'Import Truck Gate Out from Terminal', 'out_for_delivery'],
      ['2026-10-21T19:13:00-07:00', '2026-10-21T19:13:00', OAKLAND, 'Vessel Discharged at POD', 'in_transit'],
      ['2026-10-21T16:36:00-07:00', '2026-10-21T16:36:00', OAKLAND, 'Vessel Berthing at POD', 'in_transit'],
      ['2026-10-21T11:54:00-07:00', '2026-10-21T11:54:00', OAKLAND, 'Vessel Arrival at POD', 'in_transit'],
      ['2026-09-30T22:28:00+09:00', '2026-09-30T22:28:00', BUSAN, 'Vessel Departure from T/S Port', 'in_transit'],
      ['2026-09-30T15:19:00+09:00', '2026-09-30T15:19:00', BUSAN, 'Vessel Loading at T/S Port', 'in_transit'],
      ['2026-08-28T18:07:00+09:00', '2026-08-28T18:07:00', BUSAN, 'Vessel Discharged at T/S Port', 'in_transit'],
      ['2026-08-27T14:13:00+09:00', '2026-08-27T14:13:00', BUSAN, 'Vessel Berthing at T/S Port', 'in_transit'],
      ['2026-08-25T21:13:00+09:00', '2026-08-25T21:13:00', BUSAN, 'Vessel Arrival at T/S Port', 'in_transit'],
      ['2026-08-20T13:13:00+08:00', '2026-08-20T13:13:00', XINGANG, 'Vessel Departure from POL', 'in_transit'],
      ['2026-08-20T12:10:00+08:00', '2026-08-20T12:10:00', XINGANG, 'Vessel Loading at POL', 'in_transit'],
      ['2026-08-16T19:29:00+08:00', '2026-08-16T19:29:00', XINGANG, 'Export Truck Gate In to Terminal', 'accepted'],
      ['2026-08-12T20:58:00+08:00', '2026-08-12T20:58:00', XINGANG, 'Export Empty Container Released', 'registered'],
    ]);
    expect(result.events[0]).toEqual({ local_time: '2026-11-09T13:20:00', time: '2026-11-09T13:20:00-08:00', time_zone: 'America/Los_Angeles',
      time_zone_basis: 'place', location: OAKLAND, description: 'Import Empty Container Returned', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads a shipment at sea and one berthed at its port of discharge as in transit', () => {
    expect(read(TRANSSHIPPED)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Vessel Departure from T/S Port',
      last_update: '2026-11-01T11:14:00+09:00', last_update_local: '2026-11-01T11:14:00' });
    const berthed = read(BERTHED);
    expect(berthed).toMatchObject({ status: 'in_transit', last_status_text: 'Vessel Berthing at POD', last_update: '2026-11-19T08:26:00-08:00' });
    expect(berthed.events).toHaveLength(6);
  });

  it('keeps the wall clock alone where the place\'s zone is unclear, and in its row\'s order', () => {
    expect([BUSAN, OAKLAND, XINGANG, 'NEW YORK, NY', 'ROTTERDAM, NETHERLANDS'].map(placeZone))
      .toEqual(['Asia/Seoul', 'America/Los_Angeles', 'Asia/Shanghai', 'America/New_York', 'Europe/Amsterdam']);
    expect(['VANCOUVER, BC', 'MANZANILLO, MEXICO', 'NOWHERE'].map(placeZone)).toEqual([null, null, null]);
    const returned = read(BILL, $ => { moveCell($, 0, 2).text('VANCOUVER, BC'); });
    expect(returned).toMatchObject({ last_update: null, last_update_local: '2026-11-09T13:20:00' });
    expect(returned.events[0]).toEqual({ local_time: '2026-11-09T13:20:00', location: 'VANCOUVER, BC', description: 'Import Empty Container Returned',
      stage: 'delivered', stage_source: 'carrier_map' });
    const unplaced = read(BILL, $ => { moveCell($, 0, 2).text(''); });
    expect(unplaced.events[0]).toEqual({ local_time: '2026-11-09T13:20:00', description: 'Import Empty Container Returned', stage: 'delivered', stage_source: 'carrier_map' });
    const shuffled = read(BILL, $ => { $('#shipmentProgress tr.clsMoves').last().insertBefore($('#shipmentProgress tr.clsMoves').first()); });
    expect(shuffled).toEqual(read(BILL));
  });

  it('reads a container lookup as its bill\'s, and a move HMM has no stage for without one', () => {
    expect(read(BILL, undefined, CONTAINER)).toEqual(read(BILL));
    const relabelled = read(BILL, $ => { moveCell($, 0, 3).text('Import Empty Container Relocated'); });
    expect(relabelled).toMatchObject({ status: 'delivered', last_status_text: 'Import Empty Container Relocated' });
    expect(relabelled.events[0]).not.toHaveProperty('stage');
  });

  it('delivers a bill only once every container is returned empty, and follows the latest open move', () => {
    expect(read(TWO_CONTAINERS)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-10-08T11:16:00-04:00' });
    const waiting = read(TWO_CONTAINERS, $ => { containerCell($, 1, 11).text('Import Truck Gate Out from Terminal'); });
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Import Empty Container Returned' });
    expect(waiting.events).toEqual(read(TWO_CONTAINERS).events);
    const unknown = read(TWO_CONTAINERS, $ => { containerCell($, 1, 11).text('Import Rail Departure'); });
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Import Empty Container Returned' });
    expect(unknown).not.toHaveProperty('current_stage');
    const unmoved = read(TWO_CONTAINERS, $ => { containerCell($, 1, 11).text(''); containerCell($, 1, 12).text(''); });
    expect(unmoved).toMatchObject({ status: 'unknown' });
    expect(read(TWO_CONTAINERS, $ => { containerCell($, 0, 11).text(''); })).toEqual(read(TWO_CONTAINERS));
  });

  it('reads HMM\'s answer for a number it does not hold only for the kind looked up', () => {
    expect(() => hmmResult(missing('B/L'), hmmQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => hmmResult(missing('Container'), hmmQuery(CONTAINER))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => hmmResult(missing('Container'), hmmQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => hmmResult(missing('B/L'), hmmQuery(CONTAINER))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => hmmResult(missing('Booking'), hmmQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const page of ['', '<html><body>Maintenance</body></html>', `${missing('B/L')}${missing('B/L')}`]) {
      expect(() => hmmResult(page, hmmQuery(BILL)), page).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('answers no history for a shipment HMM lists without moves', () => {
    expect(() => read(BILL, $ => { $('#shipmentProgress tr.clsMoves').remove(); }))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a reply for another number or another shipment, and a changed one', () => {
    const fails = (name: string, edit: ($: CheerioAPI) => void, number = name) =>
      expect(() => read(name, edit, number)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(BILL, $ => { $('#thisBl').attr('value', 'TSNM99999999'); });
    fails(BILL, $ => { $('#thisCntr').attr('value', 'ZZZU9999992'); }, CONTAINER);
    fails(BILL, $ => { $('#thisCntr').attr('value', 'ZZZU9999992'); });
    fails(BILL, $ => { containerCell($, 0, 6).text('TSNM99999999'); });
    fails(BILL, $ => { containerCell($, 0, 1).text('HMMU710917'); });
    fails(BILL, $ => { containerCell($, 0, 12).text('2026-11-09'); });
    fails(BILL, $ => { $('#containerStatus tbody tr').remove(); });
    fails(BILL, $ => { moveCell($, 0, 0).text('2026-02-31'); });
    fails(BILL, $ => { moveCell($, 0, 0).text('1999-11-09'); });
    fails(BILL, $ => { moveCell($, 0, 1).text('24:00'); });
    fails(BILL, $ => { moveCell($, 0, 1).text('1:20'); });
    fails(BILL, $ => { moveCell($, 0, 3).text(''); });
    fails(BILL, $ => { $('#shipmentProgress').removeAttr('id'); });
  });
});

const carrier = (browserExecutablePath: string | null = '/synthetic/chromium', recorder: StepRecorder = NOOP_RECORDER) =>
  adapter({ recorder, env: {}, trawl: null, browserExecutablePath });

describe('HMM adapter', () => {
  it('takes a bill of twelve characters, after HDMU too, or a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('HMMU710917'), containerCheckDigit('ZZZU999999')]).toEqual([0, 2]);
    expect(hmmQuery(` hdmu ${BILL.toLowerCase()} `)).toEqual({ kind: 'bl', number: BILL });
    expect(hmmQuery(TWO_CONTAINERS)).toEqual({ kind: 'bl', number: TWO_CONTAINERS });
    expect(hmmQuery('hmmu 710917-0')).toEqual({ kind: 'cntr', number: CONTAINER });
    expect(JSON.parse(hmmRequestBody(hmmQuery(BILL)))).toEqual({ type: 'bl', listBl: [BILL], listCntr: [], listBkg: [], listPo: [] });
    expect(JSON.parse(hmmRequestBody(hmmQuery(CONTAINER)))).toEqual({ type: 'cntr', listBl: [], listCntr: [CONTAINER], listBkg: [], listPo: [] });
    const browser = vi.mocked(fetchHmmInBrowser).mockClear();
    for (const number of ['HMMU7109171', 'TSNM6306410', 'HDMUTSNM6306410', 'ABCDEFGHIJKL', '123456789012', 'HDMU', '1'.repeat(70)]) {
      await expect(carrier().track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier().track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(browser).not.toHaveBeenCalled();
  });

  it('searches the tracking page in a local browser, and asks for one when it has none', async () => {
    const browser = vi.mocked(fetchHmmInBrowser).mockClear().mockResolvedValue(read(BILL));
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier('/synthetic/chromium', recorder).track({ number: `HDMU${BILL}` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(browser).toHaveBeenCalledWith({ kind: 'bl', number: BILL }, '/synthetic/chromium', expect.any(AbortSignal), expect.any(Number));
    expect(recorded).toMatchObject([{ step: 'browser', outcome: 'ok' }]);
    browser.mockClear().mockRejectedValue(new NotFoundError('HMM'));
    await expect(carrier().track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    browser.mockClear();
    await expect(carrier(null).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge', message: expect.stringMatching(/TRACKING_CHROMIUM_PATH/) });
    expect(browser).not.toHaveBeenCalled();
  });

  it('is asked when the number is filed under HMM', async () => {
    vi.mocked(fetchHmmInBrowser).mockClear().mockResolvedValue(read(BILL));
    await expect(createTracker({ providers: [], env: {}, chromiumPath: '/synthetic/chromium' }).track({ number: `HDMU${BILL}`, carrier: 'hmm' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'hmm', source: 'hmm', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('hmm').tracking).toMatchObject({ adapter: 'hmm', browser: true, localClocks: true });
  });
});

describe('HMM status vocabulary', () => {
  it('stages each wording the page gives', () => {
    for (const entry of statuses.entries) {
      expect(hmmStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'hmm', providerCode: null, description: entry.wording }).kind, entry.wording).toBe('mapped');
    }
    expect(hmmStage('Import Empty Container')).toBeUndefined();
    expect(statusMap.stage(null, 'vessel loading at pol')).toBe('in_transit');
  });
});
