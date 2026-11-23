import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import {
  ARKAS_API, ARKAS_TRACKER, arkasDocumentation, arkasHistoryUrl, arkasJson, arkasMoves, arkasQuery, arkasResult, arkasSearchUrl, containerCheckDigit,
} from './parser.js';
import { arkasStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples. The unknown container is the example number another tracking site shows.
const SALERNO = 'ARKU8317250';
const ALGIERS = 'ARKU2274341';
const UNSTUFFED = 'CAXU9389216';
const PLANNED = 'ARKU8614686';
const UNUSED = 'ARKU5022908';
const UNKNOWN = 'ARKU1234560';
const SAMPLES = [SALERNO, ALGIERS, UNSTUFFED, PLANNED, UNUSED];
const DOCUMENTATIONS: Readonly<Record<string, number>> = { [SALERNO]: 285676, [ALGIERS]: 197075, [UNSTUFFED]: 1936189, [PLANNED]: 2471873, [UNUSED]: 876594 };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const search = (number: string) => fixture(`search-${number}.json`);
const history = (number: string) => fixture(`history-${number}.json`);
/** A sample's moves, staged into a result. */
const read = (number: string, body = history(number)) => arkasResult(arkasMoves(JSON.parse(body)));
const rows = (result: ReturnType<typeof arkasResult>) =>
  (result.events ?? []).map(event => [event.local_time, event.description, event.location ?? null, event.stage ?? null]);
/** A history whose moves are these, each in the sample's shape. */
const moves = (...entries: [string, string, boolean?][]) => JSON.stringify({ data: entries.map(([status, eventDate, isDummy]) => ({
  port: 'MERSIN', terminal: 'MERSIN INTERNATIONAL PORT (MIP)', status, statusCode: '', date: null, eventDate, vesselName: '', voyageNumber: '', isDummy: isDummy ?? false, isPort: true,
})) });

describe('Arkas Line replies', () => {
  it('reads a container\'s cycle newest first, at its wall clocks, from the shipper\'s booking to the empty return', () => {
    const result = read(SALERNO);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Gate In Empty',
      last_update: null, last_update_local: '2026-09-25T14:39:00', expected_delivery: null, events: expect.any(Array) });
    expect(rows(result)).toEqual([
      ['2026-09-25T14:39:00', 'Gate In Empty', 'AMENDOLA DEPOT', 'delivered'],
      ['2026-09-04T18:03:00', 'Gate Out Full Import', 'SALERNO CONTAINER TERMINAL', 'out_for_delivery'],
      ['2026-08-29T08:05:00', 'Discharge Full Import', 'SALERNO CONTAINER TERMINAL', 'in_transit'],
      ['2026-08-22T06:40:00', 'Load Full Export', 'RODAPORT TERMINAL, GEMLIK', 'in_transit'],
      ['2026-08-14T15:59:00', 'Gate In Full Export', 'RODAPORT TERMINAL, GEMLIK', 'accepted'],
      ['2026-08-13T17:49:00', 'Gate Out Empty', 'GEMLIK DEPO', 'registered'],
      ['2026-08-13T17:48:49', 'Assigned to Booking Full Export', 'GEMLIK DEPO', 'registered'],
    ]);
    expect(result.events![0]).toEqual({ local_time: '2026-09-25T14:39:00', description: 'Gate In Empty', location: 'AMENDOLA DEPOT', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('stages a transshipment as transit, and the cargo unstuffed at the port as out for delivery', () => {
    const algiers = read(ALGIERS);
    expect(algiers).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Discharge Full Import', last_update_local: '2026-11-14T07:25:00' });
    expect(rows(algiers).slice(0, 3)).toEqual([
      ['2026-11-14T07:25:00', 'Discharge Full Import', 'ALGER PORT, ALGER (ALGIERS)', 'in_transit'],
      ['2026-11-04T06:49:00', 'Load T/S Full', 'EVYAP PORT', 'in_transit'],
      ['2026-10-16T07:42:00', 'Discharge T/S Full', 'EVYAP PORT', 'in_transit'],
    ]);
    expect(rows(algiers).at(-1)).toEqual(['2026-10-04T02:27:50', 'Assigned to Booking Full Export', 'PORT SAID WEST', 'registered']);
    const unstuffed = read(UNSTUFFED);
    expect(unstuffed).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-10-26T15:37:00' });
    expect(rows(unstuffed).slice(0, 3)).toEqual([
      ['2026-10-26T15:37:00', 'Gate In Empty', 'MERSİN 2 DEPO', 'delivered'],
      ['2026-10-23T18:33:00', 'Unstuff Empty', 'MERSIN INTERNATIONAL PORT (MIP)', 'out_for_delivery'],
      ['2026-10-15T10:30:00', 'Discharge Full Import', 'MERSIN INTERNATIONAL PORT (MIP)', 'in_transit'],
    ]);
    expect(rows(unstuffed).at(-1)).toEqual(['2026-09-21T06:40:59', 'Assigned to Booking Full Export', 'NEW YORK – APMT ELIZABETH TERMINAL', 'registered']);
  });

  it('keeps the moves the service only estimates as planned steps, and gives an empty booking\'s moves no stage', () => {
    const planned = read(PLANNED);
    expect(planned).toEqual({ status: 'unknown', last_status_text: 'Assigned to Booking Empty', last_update: null, last_update_local: '2026-11-17T18:56:59',
      expected_delivery: null, events: [{ local_time: '2026-11-17T18:56:59', description: 'Assigned to Booking Empty',
        location: 'NOATUM TERMINAL CENTENARIO CASTELLON S.A.U, CASTELLON DE LA PLANA' }],
      planned_events: [
        { local_time: '2026-11-20T09:00:00', description: 'Load Empty', location: 'NOATUM TERMINAL CENTENARIO CASTELLON S.A.U, CASTELLON DE LA PLANA' },
        { local_time: '2026-12-01T04:00:00', description: 'Discharge Empty', location: 'NEMPORT, ALIAGA' },
      ] });
    // An empty container returned before it moved was not used.
    const unused = read(UNUSED);
    expect(unused).toMatchObject({ status: 'unknown', last_status_text: 'Gate In Empty', last_update_local: '2026-11-03T19:23:00' });
    expect(unused).not.toHaveProperty('current_stage');
    expect(rows(unused)).toEqual([
      ['2026-11-03T19:23:00', 'Gate In Empty', 'MERSIN DEPO (ARKAS)', null],
      ['2026-09-24T12:20:42', 'Assigned to Booking Empty', 'ABIDJAN TERMINAL', null],
    ]);
    // A shipper's estimated discharge keeps the stage it would mean, and sets none.
    const loaded = read(SALERNO, moves(['Assigned to Booking Full Export', '2026-11-01T10:00:00'], ['Load Full Export', '2026-11-03T10:00:00'],
      ['Discharge Full Import', '2026-11-20T10:00:00', true]));
    expect(loaded).toMatchObject({ current_stage: 'in_transit', planned_events: [{ local_time: '2026-11-20T10:00:00', description: 'Discharge Full Import', stage: 'in_transit' }] });
    expect(loaded.events).toHaveLength(2);
  });

  it('stages the moves of an empty container by where they fall in the cycle', () => {
    const stages = (...entries: [string, string][]) => rows(read(SALERNO, moves(...entries))).map(row => [row[1], row[3]]).reverse();
    // An empty container's gate out after the cargo left stays out for delivery until its return.
    expect(stages(['Discharge Full Import', '2026-11-01T10:00:00'], ['Unstuff Empty', '2026-11-02T10:00:00'], ['Gate Out Empty', '2026-11-03T10:00:00'],
      ['Gate In Empty', '2026-11-04T10:00:00'])).toEqual([
      ['Discharge Full Import', 'in_transit'], ['Unstuff Empty', 'out_for_delivery'], ['Gate Out Empty', 'out_for_delivery'], ['Gate In Empty', 'delivered'],
    ]);
    // After the container moved, a gate out or gate in before arrival is transit.
    expect(stages(['Gate In Full Export', '2026-11-01T10:00:00'], ['Load Full Export', '2026-11-02T10:00:00'], ['Gate In Full Export', '2026-11-03T10:00:00'],
      ['Gate Out Empty', '2026-11-04T10:00:00'])).toEqual([
      ['Gate In Full Export', 'accepted'], ['Load Full Export', 'in_transit'], ['Gate In Full Export', 'in_transit'], ['Gate Out Empty', 'in_transit'],
    ]);
    // A booking given up before the container moved: the empty one comes back unused.
    expect(stages(['Assigned to Booking Full Export', '2026-11-01T10:00:00'], ['Gate Out Empty', '2026-11-01T10:01:00'], ['Gate In Empty', '2026-11-05T10:00:00']))
      .toEqual([['Assigned to Booking Full Export', 'registered'], ['Gate Out Empty', 'registered'], ['Gate In Empty', null]]);
    // A wording the service has not shown gets no stage and leaves the others theirs; moves at one clock keep their order.
    expect(stages(['Load Full Export', '2026-11-01T10:00:00'], ['Stuff Full Export', '2026-11-01T10:00:00'], ['Discharge Full Import', '2026-11-01T10:00:00']))
      .toEqual([['Load Full Export', 'in_transit'], ['Stuff Full Export', null], ['Discharge Full Import', 'in_transit']]);
  });

  it('reads the service\'s message as a container Arkas does not hold, and a documentation without moves as listed', () => {
    expect(arkasDocumentation(JSON.parse(search(UNKNOWN)), UNKNOWN)).toBeNull();
    expect(() => arkasResult(null)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const number of SAMPLES) expect(arkasDocumentation(JSON.parse(search(number)), number), number).toBe(DOCUMENTATIONS[number]);
    expect(() => read(SALERNO, '{"data":[]}')).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const onlyPlanned = moves(['Load Full Export', '2026-12-01T10:00:00', true]);
    expect(() => read(SALERNO, onlyPlanned)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed',
      plannedEvents: [{ local_time: '2026-12-01T10:00:00', description: 'Load Full Export', location: 'MERSIN INTERNATIONAL PORT (MIP)', stage: 'in_transit' }] }));
  });

  it('reads the documentation of the latest recorded move when the search lists several', () => {
    const reply = JSON.parse(search(SALERNO));
    const row = reply.data.data[0];
    reply.data.data = [row, { ...row, documentationId: 9, lastRecordedDate: '2026-11-02T10:00:00' }, { ...row, documentationId: 8, lastRecordedDate: null }];
    expect(arkasDocumentation(reply, SALERNO)).toBe(9);
  });

  it('reads another container, a changed reply or an invalid move as such, never as missing', () => {
    const fails = (run: () => unknown, kind = 'schema') => expect(run).toThrowError(expect.objectContaining({ kind }));
    const searched = (edit: (reply: { data: { data: Record<string, unknown>[]; message?: unknown } }) => void, number = SALERNO) => {
      const reply = JSON.parse(search(number));
      edit(reply);
      return () => arkasDocumentation(reply, number);
    };
    fails(() => arkasDocumentation(JSON.parse(search(SALERNO)), ALGIERS), 'indeterminate');
    fails(searched(reply => { reply.data.data.push({ ...reply.data.data[0], containerNo: ALGIERS }); }), 'indeterminate');
    for (const id of ['285676', 0, -1, 1.5, null]) fails(searched(reply => { reply.data.data[0]!.documentationId = id; }));
    fails(searched(reply => { reply.data.message = 'An error occurred'; }, UNKNOWN));
    fails(searched(reply => { delete reply.data.message; }, UNKNOWN));
    fails(searched(reply => { reply.data.data = {} as never; }));
    for (const reply of [{}, { data: null }, { data: { data: null } }, [], null]) fails(() => arkasDocumentation(reply, SALERNO));
    const salerno = history(SALERNO);
    fails(() => read(SALERNO, salerno.replace('"isDummy": false', '"isDummy": "false"')));
    fails(() => read(SALERNO, salerno.replace('"status": "Gate Out Empty"', '"status": " "')));
    for (const clock of ['2026-08-13 17:49:00', '13.08.2026 17:49', '2026-02-30T17:49:00', '2026-08-13T24:49:00', '1999-08-13T17:49:00', '']) {
      fails(() => read(SALERNO, salerno.replace('"2026-08-13T17:49:00"', JSON.stringify(clock))));
    }
    fails(() => read(SALERNO, salerno.replace('"terminal": "GEMLIK DEPO"', '"terminal": 7')));
    for (const body of ['{}', '{"data":null}', '[]', JSON.stringify({ data: Array.from({ length: 301 }, () => ({})) })]) fails(() => read(SALERNO, body));
    fails(() => arkasJson('<html><body><h1>Server Error</h1></body></html>'));
    fails(() => arkasJson(''));
  });

  it('reads Cloudflare\'s pages as a challenge', () => {
    for (const body of ['<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>']) {
      expect(() => arkasJson(body)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(arkasJson(`\uFEFF${search(UNKNOWN)}`)).toEqual(JSON.parse(search(UNKNOWN)));
  });
});

type Reply = { status?: number; body: string };
type Call = { url: string; method: string; headers: Headers };
/** A tracking service that answers each request with the next reply, recording what it was sent. */
function service(replies: (Reply | Error)[]) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const reply = replies.shift();
    if (!reply) throw new Error('The test service has no reply left');
    if (reply instanceof Error) throw reply;
    return Object.defineProperty(new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }), 'url', { value: url });
  });
  return { fetcher, calls };
}
const found = (number: string): Reply[] => [{ body: search(number) }, { body: history(number) }];
const carrier = (fetcher: typeof fetch, recorder?: StepRecorder) =>
  adapter({ fetcher, ...(recorder ? { recorder } : {}), env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);

describe('Arkas Line adapter', () => {
  it('takes a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('ARKU831725'), containerCheckDigit('CAXU938921')]).toEqual([0, 6]);
    expect(arkasQuery(' arku 831725-0 ')).toBe(SALERNO);
    const { fetcher } = service([]);
    for (const number of ['ARKU8317251', 'ARKU831725', 'ARKA8317250', '8317250', 'ARKMER2610001234', 'ARKAS', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: SALERNO }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks the page\'s search, then the moves of the documentation it names', async () => {
    const { fetcher, calls } = service(found(SALERNO));
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, recorder).track({ number: SALERNO.toLowerCase() })).resolves.toEqual(read(SALERNO));
    expect(calls.map(call => [call.method, call.url])).toEqual([['GET', arkasSearchUrl(SALERNO)], ['GET', arkasHistoryUrl(285676)]]);
    const [first, second] = calls.map(call => new URL(call.url));
    expect(`${first!.origin}${first!.pathname}`).toBe(ARKAS_API);
    expect(Object.fromEntries(first!.searchParams)).toEqual({ controllerMethod: 'webtracking/api/shipmenttracking/GetDocumentationAsync', prms: `{"key":"${SALERNO}"}` });
    expect(Object.fromEntries(second!.searchParams)).toEqual({ controllerMethod: 'webtracking/api/shipmenttracking/GetDocumentationHistoryAsync', prms: '{"documentationId":285676}' });
    expect(Object.fromEntries(['accept', 'culture', 'referer', 'cookie'].map(name => [name, calls[0]!.headers.get(name)]))).toEqual({
      accept: 'application/json, text/plain, */*', culture: 'en-US', referer: ARKAS_TRACKER, cookie: null,
    });
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('reads an unknown container as not found without asking for moves, and refusals and failures by their kind', async () => {
    const unknown = service([{ body: search(UNKNOWN) }]);
    await expect(carrier(unknown.fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown.calls).toHaveLength(1);
    await expect(carrier(service([{ body: search(SALERNO) }]).fetcher).track({ number: ALGIERS })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(service([{ body: search(SALERNO) }, { body: '{"data":[]}' }]).fetcher).track({ number: SALERNO }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
    const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    await expect(carrier(service([{ body: challenge }]).fetcher).track({ number: SALERNO })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(service([{ body: search(SALERNO) }, { body: challenge }]).fetcher).track({ number: SALERNO })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(service([{ body: '<html><body>Error</body></html>' }]).fetcher).track({ number: SALERNO })).rejects.toMatchObject({ kind: 'schema' });
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [500, 'indeterminate'], [404, 'transport'], [410, 'transport']] as const) {
      await expect(carrier(service([{ status, body: '' }]).fetcher).track({ number: SALERNO }), String(status)).rejects.toMatchObject({ kind });
      await expect(carrier(service([{ body: search(SALERNO) }, { status, body: '' }]).fetcher).track({ number: SALERNO }), String(status)).rejects.toMatchObject({ kind });
    }
  });

  it('asks once more when a request does not reach Arkas', async () => {
    const { fetcher } = service([new TypeError('fetch failed'), ...found(SALERNO)]);
    await expect(carrier(fetcher).track({ number: SALERNO })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('is asked when the number is filed under Arkas Line', async () => {
    const { fetcher } = service(found(SALERNO));
    await expect(createTracker({ providers: [], env: {}, fetcher }).track({ number: SALERNO, carrier: 'arkas' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'arkas', source: 'arkas', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('arkas').tracking).toMatchObject({ adapter: 'arkas', localClocks: true });
  });
});

describe('Arkas Line status vocabulary', () => {
  it('stages each wording the service gives by its usual place in the cycle, and names why the others have none', () => {
    for (const entry of statuses.entries) {
      const stage = (entry as { stage?: string }).stage;
      expect(arkasStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'arkas', providerCode: null, description: entry.wording }).kind, entry.wording).toBe(stage ? 'mapped' : 'intentional_gap');
    }
    expect(arkasStage('  load   full export ')).toBe('in_transit');
    expect(statusMap.stage(null, 'stuff full export')).toBeUndefined();
    expect(statusMap.gaps.map(gap => gap.wording)).toEqual(['assigned to booking empty', 'load empty', 'discharge empty']);
  });

  it('gives each fixture move a recorded wording', () => {
    const recorded = new Set(statuses.entries.map(entry => normalizeStatusWording(entry.wording)));
    const wordings = SAMPLES.flatMap(number => {
      const { moves: actual, estimated } = arkasMoves(JSON.parse(history(number)));
      return [...actual, ...estimated].map(move => normalizeStatusWording(move.description));
    });
    expect(wordings.filter(wording => !recorded.has(wording))).toEqual([]);
  });
});
