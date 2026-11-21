import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AMASS_TRACKER, AmassTracker } from './adapter.js';
import { amassQuery, parseAmass } from './parser.js';
import { amassStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples in numbers.json.
const DELIVERED = 'AMIGL260095687A';
const DOCUMENTED = 'AMIGL260134697A';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A fetcher for the search: each sample's reply by its number, and the not-found reply for any other. */
const search = (replies: Record<string, string> = {}) => vi.fn<typeof fetch>(async (_url, init) => {
  const number = new URLSearchParams(String(init!.body)).get('sn')!;
  return reply(replies[number] ?? ([DELIVERED, DOCUMENTED].includes(number) ? fixture(number) : fixture('not-found')));
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('AMASS HTTP adapter', () => {
  it('searches a house bill and reads its order’s steps as instants', async () => {
    const fetcher = search();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new AmassTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' amigl 260095687a ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(AMASS_TRACKER);
    expect(String(init!.body)).toBe(`sn=${DELIVERED}&channel=`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'X-Requested-With': 'XMLHttpRequest' } });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Picked up', last_update: '2026-05-07T06:51:50Z', expected_delivery: null });
    expect(result.events!.map(event => [event.time, event.description, event.stage])).toEqual([
      ['2026-05-07T06:51:50Z', 'Picked up', 'delivered'],
      ['2026-05-07T06:51:50Z', 'D/O released', 'in_transit'],
      ['2026-05-05T18:43:00Z', 'Unloaded From Vessel', 'in_transit'],
      ['2026-05-04T02:25:00Z', 'Vessel Arrival', 'in_transit'],
      // The tracker lists the bill's dispatch twice.
      ['2026-03-18T02:06:53Z', 'HBL Sent', undefined],
      ['2026-03-18T01:19:10Z', 'HBL Released', undefined],
      ['2026-03-17T00:58:09Z', 'Locked (LCL)', undefined],
      ['2026-03-17T00:53:33Z', 'HBL Confirmed', undefined],
      ['2026-03-16T18:00:00Z', 'Vessel Departure', 'in_transit'],
      ['2026-03-12T22:24:48Z', 'Container Transferred to Port Completed', 'in_transit'],
      ['2026-03-12T11:02:13Z', 'Release declaration form', 'in_transit'],
      ['2026-03-12T11:02:13Z', 'Released By Customs', 'in_transit'],
      ['2026-03-12T04:42:16Z', 'Container Loading Completed', 'in_transit'],
      ['2026-03-07T07:55:13Z', 'Goods Received in Warehouse', 'accepted'],
      ['2026-03-06T10:32:50Z', 'Declaration Information Key-in In Advance', undefined],
      ['2026-03-06T10:06:03Z', 'Paperwork Received', 'registered'],
      ['2026-03-06T08:17:57Z', 'B/L Confirming', undefined],
      ['2026-03-04T05:34:43Z', 'Received order', 'registered'],
    ]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'amass', step: 'direct', outcome: 'ok' }));
  });

  it('takes its stage from the newest step that has one, past the bill’s paperwork', async () => {
    const result = await carrier(search()).track({ number: DOCUMENTED });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'HBL Sent', last_update: '2026-04-02T04:07:43Z' });
    expect(result.events!.find(event => event.stage)).toMatchObject({ description: 'Released By Customs' });
  });

  it('checks the order it is answered with, and reads the order number alone', async () => {
    const fetcher = search({ '260095687': fixture(DELIVERED) });
    await expect(carrier(fetcher).track({ number: '260095687' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(() => parseAmass(fixture(DELIVERED), amassQuery(DOCUMENTED))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = JSON.stringify({ ...JSON.parse(fixture(DELIVERED)) as Record<string, unknown>, data: { traceInfo: { orderCode: '260095687' }, traceLocation: [] } });
    expect(() => parseAmass(empty, amassQuery(DELIVERED))).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads the not-found code as not found, an account gate as withheld, and a changed reply as a schema change', async () => {
    await expect(carrier(search()).track({ number: 'AMIZZ000000000Z' })).rejects.toMatchObject({ kind: 'not_found' });
    const answer = (body: string) => carrier(search({ [DELIVERED]: body })).track({ number: DELIVERED });
    for (const code of ['403', '10020', '411']) {
      await expect(answer(JSON.stringify({ messagecode: code }))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'tracking_withheld' });
    }
    await expect(answer('{"messagecode":"500"}')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(answer('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer('{"messagecode":"0","data":{}}')).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer(fixture(DELIVERED).replace('"time":1778136710000', '"time":"later"'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps a firewall, a rate limit and an outage apart from a missing order', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: DELIVERED });
    await expect(answer(reply('<html><title>Access Denied</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(reply('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(reply('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('retries once when the first search does not reach the tracker', async () => {
    const fetcher = search();
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('gives a slow search the whole budget', async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
      }));
      const pending = carrier(hanging).track({ number: DELIVERED }, { budgetMs: 4000 });
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

  it('sends a house bill or a nine-digit order only', () => {
    expect(amassQuery('amigl260095687a')).toEqual({ number: DELIVERED, order: '260095687' });
    expect(amassQuery('260095687')).toEqual({ number: '260095687', order: '260095687' });
    for (const bad of ['AMIGL260095687', 'XYZGL260095687A', '26009568', '1'.repeat(70), '']) {
      expect(() => amassQuery(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the steps statuses.json records', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'amass', providerCode: null, description: wording }), wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
      expect(amassStage(wording)).toBe(stage ?? undefined);
    }
    expect(statusMapAnswer({ carrier: 'amass', providerCode: null, description: 'Order stopped' })).toEqual({ kind: 'unknown' });
  });
});
