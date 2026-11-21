import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, VASCO_TRACKER, VascoTracker } from './adapter.js';
import { containerCheckDigit, parseVascoBill, parseVascoMoves, vascoQuery, vascoResult } from './parser.js';
import { vascoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples in numbers.json, and the bill the container's reply names.
const BILL = 'VASKLFCOK000238';
const OPEN_BILL = 'VASJKTJEA001850';
const CONTAINER = 'VMLU3201205';
const CONTAINER_BILL = 'VASTAOKLF083071';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const rows = (name: string) => JSON.parse(fixture(name)) as Record<string, unknown>[];
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
/** A fetcher for the tracker: the bill or the container by its number, then the bill's moves. */
const tracker = (replies: Record<string, string>) => vi.fn<typeof fetch>(async (_url, init) => {
  const form = new URLSearchParams(String(init!.body));
  const key = form.get('ProType') === 'GETBLCONTAINERDTLS' ? `moves-${form.get('BlNo')}`
    : form.get('ProType') === 'GETBLDTLS' ? `bill-${form.get('BlNo')}` : `container-${form.get('ContainerNo')}`;
  return reply(replies[key] ?? fixture('not-found'));
});
const replies = Object.fromEntries([`bill-${BILL}`, `moves-${BILL}`, `bill-${OPEN_BILL}`, `moves-${OPEN_BILL}`, `container-${CONTAINER}`,
  `moves-${CONTAINER_BILL}`].map(name => [name, fixture(name)]));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Vasco Maritime HTTP adapter', () => {
  it('reads a bill, then its containers’ moves by its voyage, on the ports’ wall clocks', async () => {
    const fetcher = tracker(replies);
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new VascoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' vas-klf-cok-000238 ');
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), String(init!.body)])).toEqual([
      [VASCO_TRACKER, `ProType=GETBLDTLS&BlNo=${BILL}&keyCode=&Id1=`],
      [VASCO_TRACKER, `ProType=GETBLCONTAINERDTLS&BlNo=${BILL}&VoyageId=235850&keyCode=&Id1=`],
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'MT Returned By Consignee', last_update: null, last_update_local: '2026-09-23T14:49', expected_delivery: null });
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2026-09-23T14:49', 'MT_RETURN_BACK_ON', 'COCHIN', 'delivered'],
      ['2026-09-23T14:48', 'SHIPMENT_CLEARED_ON', 'COCHIN', 'delivered'],
      ['2026-09-23T14:47', 'MT_RETURN_BACK_ON', 'COCHIN', 'delivered'],
      ['2026-09-23T14:46', 'SHIPMENT_CLEARED_ON', 'COCHIN', 'delivered'],
      ['2026-09-20T11:39', 'CONTAINER_DISCHARGED', 'COCHIN', 'in_transit'],
      ['2026-09-13T12:35', 'CONTAINER_LOAD_TRANS', 'MUNDRA', 'in_transit'],
      ['2026-09-03T11:55', 'CONTAINER_DISCHARGED_TRANS', 'MUNDRA', 'in_transit'],
      ['2026-08-24T10:05', 'LOADED_ON_BOARD', 'KHORFAKKAN', 'in_transit'],
      ['2026-08-24T00:18', 'LOADED_ON_BOARD', 'KHORFAKKAN', 'in_transit'],
      ['2026-08-19T22:00', 'LADEN', 'KHORFAKKAN', 'accepted'],
      ['2026-08-11T22:22', 'MT', 'KHORFAKKAN', 'registered'],
      ['2026-08-11T21:51', 'MT', 'KHORFAKKAN', 'registered'],
    ]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vasco-maritime', step: 'direct', outcome: 'ok' }));
  });

  it('lets a bill’s open containers lead until every container is handed over', async () => {
    const result = await carrier(tracker(replies)).track({ number: OPEN_BILL });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'MT Returned By Consignee', last_update_local: '2026-11-19T16:11' });
    expect(result.events!.filter(event => event.provider_code === 'CONTAINER_DISCHARGED').map(event => [event.local_time, event.location]))
      .toEqual([['2026-11-12T21:16', 'JEBEL ALI'], ['2026-11-12T20:30', 'JEBEL ALI'], ['2026-11-12T06:41', 'JEBEL ALI']]);
    // The five containers' loading, a minute apart, is kept once a minute.
    expect(result.events!.filter(event => event.provider_code === 'LOADED_ON_BOARD').map(event => event.local_time)).toEqual(['2026-09-06T06:55']);
    expect(() => vascoResult([[], []])).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('follows a container to its bill and keeps that container’s moves only', async () => {
    const fetcher = tracker(replies);
    const result = await carrier(fetcher).track({ number: CONTAINER });
    expect(String(fetcher.mock.calls[0]![1]!.body)).toBe(`ProType=GETCONTAINERDTLS&ContainerNo=${CONTAINER}&keyCode=&Id1=`);
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(`ProType=GETBLCONTAINERDTLS&BlNo=${CONTAINER_BILL}&VoyageId=242002&keyCode=&Id1=`);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Container Loaded', last_update_local: '2026-10-28T07:33' });
    expect(result.events!.map(event => event.location)).toEqual(['QINGDAO', 'QINGDAO', 'QINGDAO']);
    // Of a bill's containers, a container lookup keeps the one asked.
    const bill = parseVascoBill(fixture(`bill-${OPEN_BILL}`), vascoQuery(OPEN_BILL));
    expect(parseVascoMoves(fixture(`moves-${OPEN_BILL}`), bill, vascoQuery('FFAU1628782'))).toHaveLength(1);
  });

  it('checks the bill and containers it is answered with', () => {
    const bill = parseVascoBill(fixture(`bill-${BILL}`), vascoQuery(BILL));
    expect(bill).toEqual({ bill: BILL, voyage: '235850', containers: ['VMLU3812061', 'VMLU4210855'], origin: 'KHORFAKKAN',
      loading: 'KHORFAKKAN', discharge: 'MUNDRA', final: 'COCHIN' });
    expect(() => parseVascoBill(fixture(`bill-${BILL}`), vascoQuery(OPEN_BILL))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseVascoBill(fixture(`container-${CONTAINER}`), vascoQuery('VMLU3812061'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseVascoMoves(fixture(`moves-${OPEN_BILL}`), bill, vascoQuery(BILL))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const left = { ...bill, containers: [...bill.containers, 'FFAU1628782'] };
    expect(() => parseVascoMoves(fixture(`moves-${BILL}`), left, vascoQuery('FFAU1628782'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Without a different final port, a transshipment's port is not known.
    const direct = parseVascoMoves(fixture(`moves-${BILL}`), { ...bill, final: 'MUNDRA' }, vascoQuery(BILL))[0]!;
    expect(direct.find(event => event.provider_code === 'CONTAINER_LOAD_TRANS')).not.toHaveProperty('location');
  });

  it('reads an empty reply as not found, and a changed reply as a schema change', async () => {
    await expect(carrier(tracker({})).track({ number: 'ZZZZZZZZZ000000' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(tracker({})).track({ number: 'ZZZU0000005' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(tracker({ [`bill-${BILL}`]: '' })).track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(tracker({ [`bill-${BILL}`]: 'N' })).track({ number: BILL })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(tracker({ [`bill-${BILL}`]: '<html>maintenance</html>' })).track({ number: BILL })).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(tracker({ [`bill-${BILL}`]: '{"BL_ID":"x"}' })).track({ number: BILL })).rejects.toMatchObject({ kind: 'schema' });
    const garbled = JSON.stringify(rows(`moves-${BILL}`).map(row => ({ ...row, LADEN: '2026-08-19 22:00' })));
    await expect(carrier(tracker({ ...replies, [`moves-${BILL}`]: garbled })).track({ number: BILL })).rejects.toMatchObject({ kind: 'schema' });
    const unnamed = JSON.stringify(rows(`bill-${BILL}`).map(row => ({ ...row, CONTAINER: 'VMLU3812061<BR> ?' })));
    expect(() => parseVascoBill(unnamed, vascoQuery(BILL))).toThrow(expect.objectContaining({ kind: 'schema' }));
    await expect(carrier(tracker({ ...replies, [`moves-${BILL}`]: '[]' })).track({ number: BILL }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('keeps a firewall, a rate limit and an outage apart from a missing bill', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: BILL });
    await expect(answer(reply('<html><title>Access Denied</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(reply('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(reply('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('retries once when the first request does not reach the tracker', async () => {
    const fetcher = tracker(replies);
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: BILL }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('gives a container’s slow search the whole budget', async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
      }));
      const pending = carrier(hanging).track({ number: CONTAINER }, { budgetMs: 4000 });
      const settled = expect(pending).rejects.toMatchObject({ kind: 'budget' });
      await vi.advanceTimersByTimeAsync(2500);
      // Half the budget has passed and the first search still waits.
      expect(hanging).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      await settled;
      expect(hanging).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a bill or a container whose check digit matches', () => {
    expect(vascoQuery(' vasklfcok000238 ')).toEqual({ kind: 'bill', number: BILL });
    expect(vascoQuery('VMLU 320120-5')).toEqual({ kind: 'container', number: CONTAINER });
    expect(containerCheckDigit('VMLU320120')).toBe(5);
    for (const bad of ['VMLU3201206', 'VAS000238', 'ABC123', '1'.repeat(70), '']) {
      expect(() => vascoQuery(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the moves statuses.json records', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'vasco-maritime', providerCode: code, description: wording }), code).toEqual({ kind: 'mapped', stage });
      expect(vascoStage(code)).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'vasco-maritime', providerCode: 'CONNECTING', description: 'Connecting Vessel/Voyage' })).toEqual({ kind: 'unknown' });
  });
});
