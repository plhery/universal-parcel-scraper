import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CK_LINE_CONTAINERS, CK_LINE_MOVES, CkLineTracker } from './adapter.js';
import { ckLineQuery, ckLineResult, parseCkLineContainers, parseCkLineMoves } from './parser.js';
import { ckLineStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples in numbers.json, and the booking and container their replies name.
const BILL = 'CKCODLC0021206';
const OTHER_BILL = 'CKCOPUS0223497';
const BOOKING = 'DL2602018';
const CONTAINER = 'CKLU3056592';
// A synthetic second container, whose check digit does not match.
const SECOND = 'CKLU3056593';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as {
  resMeta: Record<string, string>; resData: Record<string, unknown>[];
};
const reply = (value: unknown, init: ResponseInit = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), {
  ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const containers = fixture(`containers-${BILL}`);
const moves = fixture(`moves-${CONTAINER}`);
/** A fetcher for the e-service: the container list, then each container's moves by its number. */
const service = (list: unknown, byContainer: Record<string, unknown> = { [CONTAINER]: moves }) => vi.fn<typeof fetch>(async (url, init) => {
  if (String(url) === CK_LINE_CONTAINERS) return reply(list);
  const { reqData } = JSON.parse(String(init!.body)) as { reqData: { CNO: string } };
  return reply(byContainer[reqData.CNO] ?? fixture('not-found'));
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const withSecond = { ...containers, resData: [...containers.resData, { ...containers.resData[0], KCTCNO: SECOND }] };
const secondMoves = { ...moves, resData: moves.resData.slice(0, 4).map(row => ({ ...row, CMVENO: SECOND })) };

describe('CK Line HTTP adapter', () => {
  it('lists the bill’s containers by its serial and reads each container’s moves under the whole bill', async () => {
    const fetcher = service(containers);
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new CkLineTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ckco-dlc0021206 ');
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), JSON.parse(String(init!.body))])).toEqual([
      [CK_LINE_CONTAINERS, { reqMeta: {}, reqData: { INBNO: 'DLC0021206', INTYP: 'BNO', LANG: '', CNO: '' } }],
      [CK_LINE_MOVES, { reqMeta: {}, reqData: { INBNO: BILL, INTYP: 'BNO', LANG: 'EN', CNO: CONTAINER } }],
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty container was brought into 2026-09-03 16:24 at HGCT', last_update: null,
      last_update_local: '2026-09-03T16:24', expected_delivery: null });
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2026-09-03T16:24', 'TE', 'HUTCHISON GAMMAN CONTAINER TERMINAL', 'delivered'],
      ['2026-09-03T10:58', 'CF', 'BUSAN PIER #7', 'out_for_delivery'],
      ['2026-09-02T19:00', 'DF', 'BUSAN PIER #7', 'in_transit'],
      ['2026-08-30T10:09', 'VF', 'DCT (DALIAN CONTAINER TERMINAL)', 'in_transit'],
      ['2026-08-28T08:15', 'LF', 'DCT (DALIAN CONTAINER TERMINAL)', 'accepted'],
      ['2026-08-26T14:25', 'SF', 'SHENG TONG CY(SILVERY)', 'registered'],
    ]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ck-line', step: 'direct', outcome: 'ok' }));
  });

  it('searches a booking by its number and keeps the bill it answers under', async () => {
    const fetcher = service(containers);
    await expect(carrier(fetcher).track({ number: BOOKING })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ reqData: { INBNO: BOOKING, INTYP: 'BKN' } });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toMatchObject({ reqData: { INBNO: BILL, CNO: CONTAINER } });
    expect(() => parseCkLineContainers(containers, ckLineQuery(OTHER_BILL))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCkLineContainers(containers, ckLineQuery('DL2602019'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = parseCkLineContainers(fixture(`containers-${OTHER_BILL}`), ckLineQuery(OTHER_BILL))[0]!;
    expect(() => parseCkLineMoves(moves, other)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a damaged empty return, and only an empty return the e-service gives the import', () => {
    const other = parseCkLineContainers(fixture(`containers-${OTHER_BILL}`), ckLineQuery(OTHER_BILL))[0]!;
    expect(parseCkLineMoves(fixture(`moves-${other.number}`), other)[0]).toMatchObject({ provider_code: 'TD', stage: 'delivered' });
    const exported = { ...moves, resData: moves.resData.map(row => (row.CMVSTACD === 'TE' ? { ...row, IMPCHK: 'N' } : row)) };
    const [latest] = parseCkLineMoves(exported, parseCkLineContainers(containers, ckLineQuery(BILL))[0]!);
    expect(latest).toEqual({ local_time: '2026-09-03T16:24', description: 'Empty container was brought into 2026-09-03 16:24 at HGCT',
      location: 'HUTCHISON GAMMAN CONTAINER TERMINAL' });
  });

  it('lets a booking’s open container lead until every container is back', async () => {
    const result = await carrier(service(withSecond, { [CONTAINER]: moves, [SECOND]: secondMoves })).track({ number: BILL });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Empty container was brought into 2026-09-03 16:24 at HGCT' });
    // Moves the containers share are kept once.
    expect(result.events!.filter(event => event.provider_code === 'VF')).toHaveLength(1);
    expect(ckLineResult([parseCkLineMoves(moves, parseCkLineContainers(containers, ckLineQuery(BILL))[0]!), []])).toMatchObject({ current_stage: 'delivered' });
    expect(() => ckLineResult([[], []])).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads the empty list as not found, and a changed reply as a schema change', async () => {
    await expect(carrier(service(fixture('not-found'))).track({ number: 'ZZZ0000000' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(service({ result: [] })).track({ number: BILL })).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(service('<html>maintenance</html>')).track({ number: BILL })).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(service({ ...containers, resMeta: { resultCd: 'E' } })).track({ number: BILL })).rejects.toMatchObject({ kind: 'transport' });
    const container = parseCkLineContainers(containers, ckLineQuery(BILL))[0]!;
    const garbled = { ...moves, resData: [{ ...moves.resData[0], CMVDTM: '26/08/2026 14:25' }] };
    expect(() => parseCkLineMoves(garbled, container)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCkLineContainers({ ...containers, resData: [{ ...containers.resData[0], KCTCNO: '' }] }, ckLineQuery(BILL)))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a firewall, a rate limit and an outage apart from a missing bill', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: BILL });
    await expect(answer(reply('<html><title>Access Denied</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(reply('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(reply('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('retries once when the first request does not reach the e-service', async () => {
    const fetcher = service(containers);
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: BILL }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('sends a bill with or without its prefix, or a booking', () => {
    expect(ckLineQuery('dlc0021206')).toEqual({ kind: 'bill', number: BILL, search: 'DLC0021206' });
    expect(ckLineQuery(BILL)).toEqual({ kind: 'bill', number: BILL, search: 'DLC0021206' });
    expect(ckLineQuery(' dl 2602018 ')).toEqual({ kind: 'booking', number: BOOKING, search: BOOKING });
    for (const bad of [CONTAINER, 'ABC123', 'CKCO1234567890', '1'.repeat(70), '']) {
      expect(() => ckLineQuery(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the codes statuses.json records', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'ck-line', providerCode: code, description: wording }), code).toEqual({ kind: 'mapped', stage });
      expect(ckLineStage(code)).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'ck-line', providerCode: 'XX', description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
