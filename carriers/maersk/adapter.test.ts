import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { fetchMaerskInBrowser } from './browser.js';
import { activityCode, containerCheckDigit, maerskLookupUrl, maerskPageUrl, maerskQuery, maerskResult } from './parser.js';
import { maerskStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

vi.mock('./browser.js', () => ({ fetchMaerskInBrowser: vi.fn() }));

// The public samples: three bills of lading and the first bill's container. Other numbers are synthetic.
const BILL = '276011373';
const CONTAINER = 'MRKU8723226';
const COLOMBIA = '275040750';
const FEEDER = '275103280';

type Row = Record<string, unknown>;
type Container = Row & { container_num: string; locations: (Row & { events: Row[] })[] };
type Reply = Row & { containers: Container[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/tracking-${name}.json`, import.meta.url), 'utf8')) as Reply;
const read = (name: string, edit?: (reply: Reply) => void) => {
  const reply = fixture(name);
  edit?.(reply);
  const result = maerskResult(reply, maerskQuery(name));
  return { ...result, events: result.events ?? [] };
};
const carrier = (browserExecutablePath: string | null = '/synthetic/chromium', recorder: StepRecorder = NOOP_RECORDER) =>
  adapter({ recorder, env: {}, trawl: null, browserExecutablePath });
const rows = (result: ReturnType<typeof read>) =>
  result.events.map(event => [event.time ?? null, event.local_time, event.provider_code, event.description, event.location, event.stage]);
const lastStop = (reply: Reply, index = 0) => reply.containers[index]!.locations.at(-1)!;

const NEWARK = 'APM TERMINAL - BERTH 88 E425, NEWARK, UNITED STATES';
const SANTOS = 'DP WORLD SANTOS TERMINAL, SANTOS, BRAZIL';
const CARTAGENA = 'CARTAGENA -TERMINAL DE CONTENEDORES, CARTAGENA, COLOMBIA';
const SAN_JUAN = 'SAN JUAN-SEALAND TERMINAL, SAN JUAN, PUERTO RICO';

describe('Maersk tracking replies', () => {
  it('reads a bill\'s container moves newest first, with the instant of each wall clock whose place keeps one zone', () => {
    const result = read(BILL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty container return', last_update: '2026-10-09T07:02:00-04:00', expected_delivery: null });
    expect(result).not.toHaveProperty('planned_events');
    expect(rows(result)).toEqual([
      ['2026-10-09T07:02:00-04:00', '2026-10-09T07:02:00', 'CONTAINER-RETURN', 'Empty container return', NEWARK, 'delivered'],
      ['2026-10-06T13:38:00-04:00', '2026-10-06T13:38:00', 'GATE-OUT-DELIVERY', 'Gate out for delivery', NEWARK, 'out_for_delivery'],
      ['2026-09-29T11:51:00-04:00', '2026-09-29T11:51:00', 'DISCHARG', 'Discharge', NEWARK, 'in_transit'],
      ['2026-09-29T05:58:00-04:00', '2026-09-29T05:58:00', 'CONTAINER-ARRIVAL', 'Vessel arrival', NEWARK, 'in_transit'],
      [null, '2026-09-15T17:27:00', 'CONTAINER-DEPARTURE', 'Vessel departure', SANTOS, 'in_transit'],
      [null, '2026-09-14T02:33:00', 'LOAD', 'Load', SANTOS, 'in_transit'],
      [null, '2026-09-01T13:10:00', 'GATE-IN', 'Gate in', SANTOS, 'accepted'],
      [null, '2026-08-28T16:54:00', 'GATE-OUT-EMPTY', 'Gate out Empty', 'Transporte e Comercio Fassina Ltda, Santos, Brazil', 'registered'],
    ]);
    expect(result.events[0]).toEqual({ time: '2026-10-09T07:02:00-04:00', local_time: '2026-10-09T07:02:00', time_zone: 'America/New_York',
      time_zone_basis: 'place', location: NEWARK, description: 'Empty container return', provider_code: 'CONTAINER-RETURN', stage: 'delivered',
      stage_source: 'carrier_map' });
    expect(result.events[4]).not.toHaveProperty('time_zone');
  });

  it('reads a container\'s own moves, and leaves the rows the page does not show', () => {
    expect(read(CONTAINER)).toEqual(read(BILL));
    expect(read(CONTAINER, reply => {
      const [container] = reply.containers;
      reply.containers.unshift({ ...container!, container_num: 'ZZZU9999992', locations: container!.locations.slice(0, 1) });
    })).toEqual(read(BILL));
    expect(read(BILL, reply => {
      lastStop(reply).events.push({ activity: 'DROPCUST', stempty: false, actfor: 'DEL', event_time: '2026-10-07T09:00:00.000', event_time_type: 'ACTUAL' },
        { activity: 'GATE-IN', stempty: true, actfor: '', event_time: '2026-10-10T09:00:00.000', event_time_type: 'ESTIMATED' });
    })).toEqual(read(BILL));
  });

  it('reads Colombia\'s and Puerto Rico\'s clocks, a feeder\'s legs, and a bill\'s shared moves once', () => {
    expect(rows(read(COLOMBIA)).slice(3, 8).map(([time, , code, description, location]) => [time, code, description, location])).toEqual([
      ['2026-09-25T04:56:00-04:00', 'CONTAINER-ARRIVAL', 'Vessel arrival', NEWARK],
      ['2026-09-14T20:43:00-05:00', 'CONTAINER-DEPARTURE', 'Vessel departure', CARTAGENA],
      ['2026-09-14T02:26:00-05:00', 'LOAD', 'Load', CARTAGENA],
      ['2026-09-12T08:53:00-05:00', 'DISCHARG', 'Discharge', CARTAGENA],
      ['2026-09-11T19:48:00-05:00', 'CONTAINER-ARRIVAL', 'Vessel arrival', CARTAGENA],
    ]);
    const feeder = read(FEEDER);
    expect(feeder).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-10-01T08:35:00-04:00' });
    expect(feeder.events).toHaveLength(28);
    expect(feeder.events[0]).toMatchObject({ time_zone: 'America/Puerto_Rico', location: SAN_JUAN });
    expect(rows(feeder).slice(9, 12).map(([time, , code, description, location]) => [time, code, description, location])).toEqual([
      ['2026-09-23T09:41:00-04:00', 'CONTAINER-ARRIVAL', 'Feeder arrival', SAN_JUAN],
      ['2026-09-19T00:31:00-05:00', 'CONTAINER-DEPARTURE', 'Feeder departure', CARTAGENA],
      ['2026-09-18T21:10:00-05:00', 'LOAD', 'Load', CARTAGENA],
    ]);
  });

  it('delivers a bill only once every container is returned empty', () => {
    const waiting = read(FEEDER, reply => {
      const stop = lastStop(reply, 2);
      stop.events = stop.events.filter(event => event.activity !== 'CONTAINER RETURN');
    });
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Empty container return' });
    const unmoved = read(FEEDER, reply => { reply.containers[2]!.locations = []; });
    expect(unmoved).toMatchObject({ status: 'unknown', last_update: '2026-10-01T08:24:00-04:00' });
    expect(unmoved).not.toHaveProperty('current_stage');
  });

  it('reads a gate in after the container moved as transit, and the labels of an empty or delivered container\'s gate moves', () => {
    const relayed = read(BILL, reply => {
      lastStop(reply).events.push({ activity: 'GATE-IN', stempty: false, actfor: '', event_time: '2026-09-30T10:00:00.000', event_time_type: 'ACTUAL' });
    });
    expect(relayed.events[2]).toMatchObject({ provider_code: 'GATE-IN', stage: 'in_transit', time: '2026-09-30T10:00:00-04:00' });
    expect([activityCode('GATE-OUT', true, 'EXP'), activityCode('GATE-OUT', false, 'DEL'), activityCode('GATE-OUT', false, 'EXP'),
      activityCode('CUSTOMER_GATE_IN', true, ''), activityCode('CONTAINER DEPARTURE', false, ''), activityCode('RAIL_ARRIVAL_AT_DESTINATION', false, '')])
      .toEqual(['GATE-OUT-EMPTY', 'GATE-OUT-DELIVERY', 'GATE-OUT', 'CUSTOMER-GATE-IN-EMPTY', 'CONTAINER-DEPARTURE', 'RAIL-ARRIVAL-AT-DESTINATION']);
  });

  it('keeps the moves Maersk still expects as planned steps, and the wall clock as the last update when the newest has no zone', () => {
    const sailing = read(BILL, reply => {
      for (const event of lastStop(reply).events) event.event_time_type = 'EXPECTED';
    });
    expect(sailing).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Vessel departure', last_update: null,
      last_update_local: '2026-09-15T17:27:00' });
    expect(sailing.events).toHaveLength(4);
    expect(sailing.planned_events).toEqual([
      { time: '2026-09-29T05:58:00-04:00', description: 'Vessel arrival', location: NEWARK, stage: 'in_transit' },
      { time: '2026-09-29T11:51:00-04:00', description: 'Discharge', location: NEWARK, stage: 'in_transit' },
      { time: '2026-10-06T13:38:00-04:00', description: 'Gate out for delivery', location: NEWARK, stage: 'out_for_delivery' },
      { time: '2026-10-09T07:02:00-04:00', description: 'Empty container return', location: NEWARK, stage: 'delivered' },
    ]);
  });

  it('answers no history for a shipment Maersk lists without moves, and says when it is cancelled', () => {
    expect(() => read(BILL, reply => { reply.containers = []; })).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed',
      message: expect.stringContaining('Maersk lists the shipment without events') }));
    expect(() => read(BILL, reply => { reply.containers = []; reply.is_cancelled_shipment = true; }))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed', message: expect.stringContaining('cancelled') }));
    expect(() => read(BILL, reply => {
      for (const location of reply.containers[0]!.locations) for (const event of location.events) event.event_time_type = 'EXPECTED';
    })).toThrowError(expect.objectContaining({ reason: 'listed', plannedEvents: expect.arrayContaining([expect.objectContaining({ description: 'Gate out Empty' })]) }));
  });

  it('refuses a reply for another number, another kind of lookup or another shipment, and a changed one', () => {
    const fails = (name: string, edit: (reply: Reply) => void) => expect(() => read(name, edit)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(BILL, reply => { reply.tpdoc_num = '999999999'; });
    fails(BILL, reply => { reply.is_container_search = true; });
    fails(BILL, reply => { delete reply.is_container_search; });
    fails(CONTAINER, reply => { reply.is_container_search = false; });
    fails(CONTAINER, reply => { reply.containers[0]!.container_num = 'ZZZU9999992'; });
    fails(BILL, reply => { reply.containers[0]!.shipment_num = '999999999'; });
    fails(BILL, reply => { lastStop(reply).events[0]!.event_time = 'yesterday'; });
    fails(BILL, reply => { lastStop(reply).events[0]!.event_time = '2026-02-31T10:00:00.000'; });
    fails(BILL, reply => { lastStop(reply).events[0]!.event_time = '1999-10-01T10:00:00.000'; });
    fails(BILL, reply => { lastStop(reply).events[0]!.stempty = 'false'; });
    fails(BILL, reply => { lastStop(reply).events[0]!.activity = 7; });
    fails(BILL, reply => { reply.containers = {} as never; });
    fails(BILL, reply => { reply.containers[0]!.locations = [null] as never; });
    expect(() => maerskResult([], maerskQuery(BILL))).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Maersk adapter', () => {
  it('takes a bill or booking of nine characters, after MAEU too, or a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('MRKU872322'), containerCheckDigit('ZZZU999999')]).toEqual([6, 2]);
    expect(maerskQuery(` maeu ${BILL} `)).toEqual({ kind: 'document', number: BILL });
    expect(maerskQuery('mrku 872322-6')).toEqual({ kind: 'container', number: CONTAINER });
    expect(maerskQuery('MAEU12345')).toEqual({ kind: 'document', number: 'MAEU12345' });
    expect(maerskPageUrl(maerskQuery(BILL))).toBe(`https://www.maersk.com/tracking/${BILL}`);
    expect(maerskLookupUrl(maerskQuery(CONTAINER))).toBe(`https://api.maersk.com/synergy/tracking/${CONTAINER}?operator=MAEU`);
    const browser = vi.mocked(fetchMaerskInBrowser).mockClear();
    for (const number of ['MRKU8723227', '27601137', 'MAEU27601137', 'ABCDEFGHI', 'SAMPLETRACKING', '1'.repeat(70)]) {
      await expect(carrier().track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier().track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(browser).not.toHaveBeenCalled();
  });

  it('follows the tracking page in a local browser, and asks for one when it has none', async () => {
    const browser = vi.mocked(fetchMaerskInBrowser).mockClear().mockResolvedValue(read(BILL));
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier('/synthetic/chromium', recorder).track({ number: `MAEU${BILL}` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(browser).toHaveBeenCalledWith({ kind: 'document', number: BILL }, '/synthetic/chromium', expect.any(AbortSignal), expect.any(Number));
    expect(recorded).toMatchObject([{ step: 'browser', outcome: 'ok' }]);
    browser.mockClear().mockRejectedValue(new NotFoundError('Maersk'));
    await expect(carrier().track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    browser.mockClear();
    await expect(carrier(null).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge', message: expect.stringMatching(/TRACKING_CHROMIUM_PATH/) });
    expect(browser).not.toHaveBeenCalled();
  });

  it('is asked when the number is filed under Maersk or comes in a link to its tracking page', async () => {
    vi.mocked(fetchMaerskInBrowser).mockClear().mockResolvedValue(read(BILL));
    await expect(createTracker({ providers: [], env: {}, chromiumPath: '/synthetic/chromium' }).track({ number: BILL, carrier: 'maersk' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'maersk', source: 'maersk', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('maersk').tracking).toMatchObject({ adapter: 'maersk', browser: true, localClocks: true });
    for (const number of [BILL, CONTAINER]) {
      expect(parseTrackingInput(`https://www.maersk.com/tracking/${number}`)).toMatchObject({ trackingNumber: number, carrier: 'maersk', source: 'link' });
    }
    expect(parseTrackingInput(`https://delivers.maersk.com/tracking/${BILL}`)).toMatchObject({ carrier: 'pilot-freight' });
  });
});

describe('Maersk status vocabulary', () => {
  it('stages each label the page gives, and leaves those only the place tells apart', () => {
    for (const entry of statuses.entries) {
      expect(maerskStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'maersk', providerCode: entry.code, description: entry.wording }).kind, entry.code)
        .toBe(entry.stage ? 'mapped' : 'intentional_gap');
    }
    expect(maerskStage('GATE OUT')).toBeUndefined();
    expect(statusMap.stage(null, 'Gate in')).toBeUndefined();
  });
});
