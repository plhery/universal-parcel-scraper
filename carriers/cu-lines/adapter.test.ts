import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import {
  containerCheckDigit, CU_LINES_API, cuLinesCycles, cuLinesJson, cuLinesLatestCycle, cuLinesMoves, cuLinesQuery, cuLinesResult, cuLinesShipment, MAX_DETAILS,
} from './parser.js';
import { cuLinesStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples, their bookings and the containers CU Lines lists on them. Other numbers are synthetic.
const SOKHNA = 'CULVSOK2601552';
const SOKHNA_CONTAINERS = ['MAGU2339106', 'TGCU2020638', 'CULU1911100'];
const HAIPHONG = 'CULVHPH2603770';
const HAIPHONG_CONTAINERS = ['CULU6155032', 'HPCU4776024', 'CIMU3282476'];
const NINGBO_CONTAINER = 'CULU6355200';

type Row = Record<string, unknown>;
type Reply = { TRANS_RESULT_KEY: string; Exception: string; count: string; list: Row[] };
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string, edit?: (reply: Reply) => void) => {
  const reply = JSON.parse(raw(name)) as Reply;
  edit?.(reply);
  return reply;
};
// CU Lines' answer for a number it holds nothing under.
const NONE = { TRANS_RESULT_KEY: 'S', Exception: '', count: '0' };

/** A container's result from its bookings and its moves in the cycle the bookings name. */
const container = (number: string, edit?: (reply: Reply) => void) => {
  const [cycle] = cuLinesCycles(fixture(`122-${number}`))!;
  const result = cuLinesResult({ containers: [{ number, ...cycle!, latest: null }], more: false },
    new Map([[number, cuLinesMoves(fixture(`125-${number}`, edit), cycle!.copNo)]]));
  return { ...result, events: result.events ?? [] };
};
/** A booking's result from its containers and the moves of the containers named, each optionally edited. */
const booking = (number: string, containers: Record<string, ((reply: Reply) => void) | undefined>, edit?: (reply: Reply) => void) => {
  const shipment = cuLinesShipment(fixture(`121-B-${number}`, edit), number)!;
  const details = new Map(Object.entries(containers).map(([name, change]) =>
    [name, cuLinesMoves(fixture(`125-${name}`, change), shipment.containers.find(item => item.number === name)!.copNo)]));
  const result = cuLinesResult(shipment, details);
  return { ...result, events: result.events ?? [] };
};
const rows = (result: { events: { local_time?: string; description?: string; location?: string; provider_code?: string; stage?: string }[] }) =>
  result.events.map(event => [event.local_time, event.provider_code, event.description, event.location ?? null, event.stage ?? null]);

const RSGT = 'Red Sea Gateway Terminal (RSGT), JEDDAH, Saudi Arabia';
const NANSHA = 'Nansha International Container Terminal P III, NANSHA, CHINA';
const NDV = 'Nam Dinh Vu Port (NDV), HAIPHONG, VIETNAM';
const DP_WORLD = 'DP World Sokhna, SOKHNA, EGYPT';

describe('CU Lines replies', () => {
  it('reads a container\'s moves newest first at their wall clocks, staged by their codes', () => {
    const result = container(HAIPHONG_CONTAINERS[0]!);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty Container Returned from Customer', last_update: null, last_update_local: '2026-11-11T13:24:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(rows(result)).toEqual([
      ['2026-11-11T13:24:00', 'TAIYDM', 'Empty Container Returned from Customer', 'MAMAS LOGISTICS, JEDDAH, Saudi Arabia', 'delivered'],
      ['2026-11-11T08:04:00', 'TDIMOF', 'Gate Out from Inbound Terminal for Delivery to Consignee (or Port Shuttle)', RSGT, 'out_for_delivery'],
      ['2026-11-05T13:52:00', 'VUUMDF', 'Unloaded from \'MYD TIANJIN 2642W\' at Port of Discharging', RSGT, 'in_transit'],
      ['2026-11-03T23:12:00', 'VBUMDF', '\'MYD TIANJIN 2642W\' POD Berthing Destination', RSGT, 'in_transit'],
      ['2026-11-03T09:00:00', 'VAUMDF', '\'MYD TIANJIN 2642W\' Arrival at Port of Discharging', RSGT, 'in_transit'],
      ['2026-10-11T07:10:00', 'VDTMOF', '\'MYD TIANJIN 2642W\' Depature from Transhipment Port', NANSHA, 'in_transit'],
      ['2026-10-10T22:11:00', 'VLTMOF', 'Loaded on \'MYD TIANJIN 2642W\' at Transhipment Port', NANSHA, 'in_transit'],
      ['2026-10-10T18:30:00', 'VUTMDF', 'Unloaded from \'PRIDE PACIFIC 2639N\' at Transhipment Port', NANSHA, 'in_transit'],
      ['2026-10-05T09:25:00', 'VBTMDF', '\'PRIDE PACIFIC 2639N\' T/S Berthing Destination', NANSHA, 'in_transit'],
      ['2026-10-05T06:14:00', 'VATMDF', '\'PRIDE PACIFIC 2639N\' Arrival at Transhipment Port', NANSHA, 'in_transit'],
      ['2026-10-02T00:30:00', 'VDLMOF', '\'PRIDE PACIFIC 2639N\' Departure from Port of Loading', NDV, 'in_transit'],
      ['2026-10-01T15:56:00', 'VLLMOF', 'Loaded on \'PRIDE PACIFIC 2639N\' at Port of Loading', NDV, 'in_transit'],
      ['2026-09-25T14:48:00', 'TAOMDF', 'Gate In to Outbound Terminal', NDV, 'accepted'],
      ['2026-09-25T05:30:00', 'TDOYOM', 'Empty Container Release to Shipper', 'GREATING FORTURE 3 CONTAINER JOINT STOCK CO., HAIPHONG, VIETNAM', 'registered'],
    ]);
    expect(result.events[0]).toEqual({ local_time: '2026-11-11T13:24:00', location: 'MAMAS LOGISTICS, JEDDAH, Saudi Arabia',
      description: 'Empty Container Returned from Customer', provider_code: 'TAIYDM', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads a transshipment by truck and the vessel codes of another operator, and keeps moves the list dates out of order by their clocks', () => {
    const result = container(NINGBO_CONTAINER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(rows(result).filter(([, code]) => ['WLLMOF', 'TDTMOF', 'VLTMOF'].includes(code!)).map(([time, code, , , stage]) => [time, code, stage])).toEqual([
      ['2026-11-05T23:41:00', 'VLTMOF', 'in_transit'],
      ['2026-10-19T06:02:00', 'TDTMOF', 'in_transit'],
      ['2026-10-18T23:09:00', 'VLTMOF', 'in_transit'],
      ['2026-09-28T15:00:00', 'WLLMOF', 'in_transit'],
    ]);
    // Sokhna lists its unloading after a load it dates earlier; the clocks order them.
    expect(rows(result).slice(6, 8).map(([time, code]) => [time, code])).toEqual([['2026-11-06T05:30:00', 'VUTMDF'], ['2026-11-05T23:41:00', 'VLTMOF']]);
  });

  it('leaves out the moves CU Lines only estimates', () => {
    const result = container(SOKHNA_CONTAINERS[2]!);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-10-23T16:42:00',
      last_status_text: '\'WAN FU DA 2638E\' Departure from Port of Loading' });
    expect(rows(result).map(([time, code]) => [time, code])).toEqual([
      ['2026-10-23T16:42:00', 'VDLMOF'], ['2026-10-23T09:06:00', 'VLLMOF'], ['2026-10-21T14:52:00', 'TAOMDF'], ['2026-10-13T02:19:00', 'TDOYOM'],
    ]);
    expect(fixture(`125-${SOKHNA_CONTAINERS[2]}`).list.filter(row => row.actTpCd === 'E')).toHaveLength(9);
    expect(() => container(SOKHNA_CONTAINERS[2]!, reply => { for (const row of reply.list) row.actTpCd = 'E'; }))
      .toThrowError(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('reads a gate in after the container moved as transit, and an empty container returned unused as no delivery', () => {
    const moved = container(HAIPHONG_CONTAINERS[0]!, reply => { reply.list.push({ ...reply.list[1]!, eventDt: '2026-11-12 08:00' }); reply.count = '15'; });
    expect(moved.events[0]).toMatchObject({ provider_code: 'TAOMDF', stage: 'in_transit' });
    expect(moved).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    const unused = container(HAIPHONG_CONTAINERS[0]!, reply => { reply.list = [reply.list[0]!, reply.list.at(-1)!]; });
    expect(unused).toMatchObject({ status: 'pending', current_stage: 'registered' });
    expect(unused.events[0]).not.toHaveProperty('stage');
  });

  it('reads the first containers of a booking with their moves, keeps the latest move of the others, and marks it truncated', () => {
    const result = booking(SOKHNA, Object.fromEntries(SOKHNA_CONTAINERS.map(number => [number, undefined])));
    expect(cuLinesShipment(fixture(`121-B-${SOKHNA}`), SOKHNA)!.containers.slice(0, MAX_DETAILS).map(item => item.number)).toEqual(SOKHNA_CONTAINERS);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', history_truncated: true, last_update_local: '2026-10-23T16:42:00' });
    // The departure all twenty share is one move: the asked containers' wording names the vessel.
    expect(rows(result)[0]).toEqual(['2026-10-23T16:42:00', 'VDLMOF', '\'WAN FU DA 2638E\' Departure from Port of Loading', DP_WORLD, 'in_transit']);
    expect(rows(result).map(([, code]) => code)).toEqual(['VDLMOF', 'VLLMOF', 'VLLMOF', 'VLLMOF', 'TAOMDF', 'TAOMDF', 'TAOMDF', 'TDOYOM', 'TDOYOM', 'TDOYOM']);
    // A container whose moves were not asked keeps the container list's wording.
    const latest = cuLinesShipment(fixture(`121-B-${SOKHNA}`), SOKHNA)!.containers[3]!.latest;
    expect(latest).toEqual({ local_time: '2026-10-23T16:42:00', location: DP_WORLD, description: 'Vessel Departure from Port of Loading',
      provider_code: 'VDLMOF', stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('delivers a booking once every container is back, and leads with the latest open stage until then', () => {
    const all = Object.fromEntries(HAIPHONG_CONTAINERS.map(number => [number, undefined]));
    const result = booking(HAIPHONG, all);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-11-11T21:52:00' });
    expect(result).not.toHaveProperty('history_truncated');
    expect(result.events).toHaveLength(28);
    const waiting = booking(HAIPHONG, { ...all, [HAIPHONG_CONTAINERS[2]!]: reply => { reply.list.pop(); } });
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    const unseen = booking(HAIPHONG, { ...all, [HAIPHONG_CONTAINERS[2]!]: reply => { reply.list = []; reply.count = '0'; delete (reply as Partial<Reply>).list; } });
    expect(unseen).toMatchObject({ status: 'unknown' });
    expect(unseen).not.toHaveProperty('current_stage');
  });

  it('takes a container\'s latest cycle by the dates of its rows, or the first listed', () => {
    const current = { bkgNo: SOKHNA, copNo: 'L2026A06847343' };
    const earlier = { bkgNo: 'CULVSOK2500017', copNo: 'L2025300000017' };
    expect(cuLinesLatestCycle(fixture('121-C-CULU1911100'), 'CULU1911100', [earlier, current])).toEqual(current);
    expect(cuLinesLatestCycle(fixture('121-C-CULU1911100', reply => {
      reply.list.push({ ...reply.list[0]!, copNo: earlier.copNo, bkgNo: earlier.bkgNo, eventDt: '2026-11-01 10:00' });
      reply.count = String(reply.list.length);
    }), 'CULU1911100', [current, earlier])).toEqual(earlier);
    expect(cuLinesLatestCycle(fixture('121-C-CULU1911100'), 'CULU6155032', [earlier, current])).toEqual(earlier);
    expect(cuLinesLatestCycle(NONE, 'CULU1911100', [earlier, current])).toEqual(earlier);
  });

  it('reads CU Lines\' empty answer as missing, and nothing else', () => {
    expect(cuLinesCycles(NONE)).toBeNull();
    expect(cuLinesShipment(NONE, SOKHNA)).toBeNull();
    expect(cuLinesMoves(NONE, 'L2026A06847343')).toEqual({ moves: [], more: false });
    expect(() => cuLinesResult(null)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const fails = (reply: unknown) => expect(() => cuLinesShipment(reply, SOKHNA), JSON.stringify(reply).slice(0, 80)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails({ ...NONE, TRANS_RESULT_KEY: 'F' });
    fails({ ...NONE, Exception: 'java.lang.NullPointerException' });
    fails({ ...NONE, list: [] });
    fails({ ...NONE, message: 'busy' });
    fails({ TRANS_RESULT_KEY: 'S', Exception: '' });
    fails({ ...NONE, count: '' });
    fails([]);
    fails('');
  });

  it('refuses a booking row for another booking or container, and moves of another cycle', () => {
    const fails = (edit: (reply: Reply) => void, number = SOKHNA) =>
      expect(() => cuLinesShipment(fixture(`121-B-${SOKHNA}`, edit), number)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(() => {}, HAIPHONG);
    fails(reply => { reply.list[4]!.bkgNo = HAIPHONG; reply.list[4]!.dspBkgNo = HAIPHONG; });
    fails(reply => { reply.list[0]!.cntrNo = 'MAGU233910'; });
    fails(reply => { reply.list.push(reply.list[0]!); reply.count = '21'; });
    fails(reply => { reply.count = '19'; });
    fails(reply => { reply.list[0]!.eventDt = '2026-11-31 10:00'; });
    fails(reply => { reply.list[0]!.statusCd = {}; });
    // The move list answers for the cycle asked whatever container it names: the reference binds it.
    const mismatch = fixture(`125-${SOKHNA_CONTAINERS[2]}`);
    expect(() => cuLinesMoves(mismatch, cuLinesShipment(fixture(`121-B-${SOKHNA}`), SOKHNA)!.containers[0]!.copNo))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    const detail = (edit: (reply: Reply) => void) =>
      expect(() => cuLinesMoves(fixture(`125-${SOKHNA_CONTAINERS[2]}`, edit), 'L2026A06847343')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    detail(reply => { reply.list[0]!.actTpCd = ''; });
    detail(reply => { reply.list[0]!.eventDt = '2026/10/13 02:19'; });
    detail(reply => { reply.list[0]!.eventDt = '1999-10-13 02:19'; });
    detail(reply => { reply.list[0]!.statusNm = ' '; });
    detail(reply => { reply.list[0]!.yardNm = 7; });
    detail(reply => { reply.list[0]!.copNo = {}; });
  });

  it('reads a firewall\'s page as a challenge, and other pages as a changed reply', () => {
    expect(() => cuLinesJson('<html><head><title>Just a moment...</title></head></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => cuLinesJson('<html><script>var arg1=\'x\';document.cookie="acw_sc__v2="</script></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const body of ['', '<html><body>System maintenance</body></html>', '{"TRANS_RESULT_KEY":"S"']) {
      expect(() => cuLinesJson(body), body).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(cuLinesJson(raw('122-CULU1911100'))).toMatchObject({ TRANS_RESULT_KEY: 'S', count: '1' });
  });
});

/** CU Lines' replies come as text/html, whatever they hold. */
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
const HOST_AGENT = 'parcel-host/1.0 (+https://example.org/bot)';
const carrier = (fetcher: typeof fetch, recorder?: StepRecorder) =>
  adapter({ fetcher, userAgent: HOST_AGENT, ...(recorder ? { recorder } : {}), env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);
const form = (init: RequestInit | undefined) => Object.fromEntries(new URLSearchParams(String(init?.body)));
/** Answers the eService's commands from the fixtures, or as CU Lines answers a number it does not hold. */
const site = (replies: Record<string, unknown> = {}) => vi.fn<typeof fetch>(async (_input, init) => {
  const fields = form(init);
  const names: Record<string, string> = { 122: `122-${fields.cntr_no}`, 121: `121-${fields.search_type}-${fields.search_name}`, 125: `125-${fields.cntr_no}` };
  const name = names[fields.f_cmd!]!;
  if (replies[name]) return reply(replies[name]);
  try {
    return reply(raw(name));
  } catch {
    return reply(NONE);
  }
});
const sent = (fetcher: ReturnType<typeof site>) => fetcher.mock.calls.map(([, init]) => String(init?.body));

describe('CU Lines adapter', () => {
  it('takes a booking or bill of fourteen characters, or a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('CULU191110'), containerCheckDigit('ZZZU999999')]).toEqual([0, 2]);
    expect(cuLinesQuery(' culv sok 2601552 ')).toEqual({ kind: 'booking', number: SOKHNA });
    expect(cuLinesQuery('culu 191110-0')).toEqual({ kind: 'container', number: 'CULU1911100' });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CULU1911101', 'CULVSOK260155', 'CULVSOK26015520', 'CULV5OK2601552', 'COSVSOK2601552', 'SYS2600000000000017', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: SOKHNA }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks for a container\'s bookings, then its moves in that cycle, as the tracking page posts them', async () => {
    const fetcher = site();
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, recorder).track({ number: HAIPHONG_CONTAINERS[0]! })).resolves.toMatchObject({ current_stage: 'delivered', events: expect.any(Array) });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([[CU_LINES_API, 'POST'], [CU_LINES_API, 'POST']]);
    expect(sent(fetcher)).toEqual(['f_cmd=122&cntr_no=CULU6155032', `f_cmd=125&cntr_no=CULU6155032&bkg_no=${HAIPHONG}&cop_no=L2026924828991`]);
    const headers = new Headers(fetcher.mock.calls[0]![1]!.headers);
    expect([headers.get('content-type'), headers.get('user-agent')]).toEqual(['application/x-www-form-urlencoded; charset=UTF-8', HOST_AGENT]);
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('asks for the container\'s rows when it lists several bookings, and reads the latest cycle', async () => {
    const two = fixture('122-CULU1911100', value => {
      value.list.unshift({ ...value.list[0]!, bkgNo: 'CULVSOK2500017', copNo: 'L2025300000017' });
      value.count = '2';
    });
    const fetcher = site({ '122-CULU1911100': two });
    await expect(carrier(fetcher).track({ number: 'CULU1911100' })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(sent(fetcher)).toEqual(['f_cmd=122&cntr_no=CULU1911100', 'f_cmd=121&search_type=C&search_name=CULU1911100',
      `f_cmd=125&cntr_no=CULU1911100&bkg_no=${SOKHNA}&cop_no=L2026A06847343`]);
  });

  it('asks for a booking\'s containers, then the moves of the first ones only', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).track({ number: SOKHNA })).resolves.toMatchObject({ current_stage: 'in_transit', history_truncated: true });
    expect(sent(fetcher)).toEqual([`f_cmd=121&search_type=B&search_name=${SOKHNA}`,
      `f_cmd=125&cntr_no=MAGU2339106&bkg_no=${SOKHNA}&cop_no=L2026A06847341`,
      `f_cmd=125&cntr_no=TGCU2020638&bkg_no=${SOKHNA}&cop_no=L2026A06847360`,
      `f_cmd=125&cntr_no=CULU1911100&bkg_no=${SOKHNA}&cop_no=L2026A06847343`]);
    const all = site();
    await expect(carrier(all).track({ number: HAIPHONG })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(all).toHaveBeenCalledTimes(1 + HAIPHONG_CONTAINERS.length);
  });

  it('refuses moves another container\'s cycle answers with', async () => {
    const fetcher = site({ [`125-${SOKHNA_CONTAINERS[0]}`]: raw(`125-${SOKHNA_CONTAINERS[2]}`) });
    await expect(carrier(fetcher).track({ number: SOKHNA })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads a number CU Lines does not hold as not found, and refusals and changed replies by their kind', async () => {
    await expect(carrier(site()).track({ number: 'CULU1234566' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site()).track({ number: 'CULVSOK9999999' })).rejects.toMatchObject({ kind: 'not_found' });
    const answer = (body: unknown, status = 200) => carrier(async () => reply(body, status)).track({ number: SOKHNA });
    await expect(answer('<html><title>Access Denied</title></html>', 403)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer('', 429)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer('', 503)).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(answer('', 500)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(answer('<html>Not Found</html>', 404)).rejects.toMatchObject({ kind: 'transport' });
    await expect(answer('<html><body>Error</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer({ TRANS_RESULT_KEY: 'F', Exception: 'ORA-01013', count: '0' })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks once more when a request does not reach CU Lines', async () => {
    const fixtures = site();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(fixtures);
    await expect(carrier(fetcher).track({ number: HAIPHONG_CONTAINERS[0]! })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('is asked when the number is filed under CU Lines', async () => {
    await expect(createTracker({ providers: [], env: {}, fetcher: site() }).track({ number: NINGBO_CONTAINER, carrier: 'cu-lines' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'cu-lines', source: 'cu-lines', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('cu-lines').tracking).toMatchObject({ adapter: 'cu-lines', localClocks: true });
  });
});

describe('CU Lines status vocabulary', () => {
  it('stages each move by its code, whatever vessel its wording names', () => {
    for (const entry of statuses.entries) {
      expect(cuLinesStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'cu-lines', providerCode: entry.code, description: entry.wording }).kind, entry.code).toBe('mapped');
    }
    expect(statusMap.stage('VDLMOF', 'vessel departure from port of loading')).toBe('in_transit');
    expect(statusMap.stage('ZZZZZZ', 'empty container returned from customer')).toBeUndefined();
    expect(statusMap.stage(null, 'empty container returned from customer')).toBeUndefined();
  });
});
