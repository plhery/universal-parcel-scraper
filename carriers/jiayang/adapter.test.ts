import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JIAYANG_API, JIAYANG_PAGE, JiayangTracker } from './adapter.js';
import { normalizeJiayangNumber, parseJiayang } from './parser.js';
import { jiayangStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = 'JYGJ9958314719YQ';
const IN_TRANSIT = 'JYGJ9958314702YQ';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };

// The tracker's body: a JSON string holding the array.
const body = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(JSON.parse(body(name)) as string) as Item[];
const changed = (name: string, change: (item: Item) => void) => {
  const reply = fixture(name);
  change(reply[0]!);
  return reply;
};
const reply = (payload: unknown, init: ResponseInit = {}) => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jiayang HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JiayangTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jygj 9958-3147 02 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${JIAYANG_API}?nos=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'Accept-Language': 'zh-CN', Referer: `${JIAYANG_PAGE}?nos=${IN_TRANSIT}`, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jiayang', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the array whether the tracker encodes it once more as a string or not', async () => {
    for (const payload of [body('in-transit'), fixture('in-transit')]) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(payload))).track({ number: IN_TRANSIT }))
        .resolves.toMatchObject({ current_stage: 'in_transit', destination_country: 'US' });
    }
  });

  it('reads Jiayang’s steps on Beijing time, stages them by their wording and keeps the towns abroad apart', () => {
    const result = parseJiayang(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Leaving the sorting center', last_update: '2026-03-27T10:12:40+08:00',
      expected_delivery: null, destination_country: 'US' });
    expect(result.events!.map((event) => [event.time, event.stage, event.location ?? null])).toEqual([
      ['2026-03-27T10:12:40+08:00', 'in_transit', 'Sample Town, Sample State'],
      ['2026-03-26T21:05:13+08:00', 'in_transit', 'Sample Town, Sample State'],
      ['2026-03-26T08:47:52+08:00', 'in_transit', 'Sample Town, Sample State'],
      ['2026-03-24T19:41:05+08:00', 'in_transit', null],
      ['2026-03-23T08:20:13+08:00', 'customs', 'Sample Port'],
      ['2026-03-21T02:51:38+08:00', 'in_transit', null],
      ['2026-03-18T06:01:25+08:00', 'in_transit', null],
      ['2026-03-16T05:40:21+08:00', 'in_transit', null],
      ['2026-03-14T14:45:17+08:00', 'in_transit', null],
      ['2026-03-13T04:03:05+08:00', 'accepted', null],
      ['2026-03-12T16:07:29+08:00', 'registered', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/中国|天|00000/);
  });

  it('reads only the tracker’s unknown-number answer as not found, and binds the reply to the number asked', () => {
    expect(() => parseJiayang(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found', provider: 'Jiayang' }));
    expect(() => parseJiayang(changed('in-transit', (item) => { item.details = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseJiayang(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jiayang answered for another shipment' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (payload: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(payload, init))).track({ number: UNKNOWN });
    await expect(lookup(body('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(body('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.jygjgyl.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>var arg1=\'00\';document.cookie="acw_sc__v2=00"</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>系统发生错误</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(JSON.stringify('<html></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    });

  it('rejects what is no waybill, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JYGJ99', 'SAMPLETRACKING', `JYGJ${'0'.repeat(40)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJiayangNumber('jygj 9958314702 yq')).toBe(IN_TRANSIT);
  });

  it('sends a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed or linked under Jiayang to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'jiayang' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jiayang', source: 'jiayang', result: { current_stage: 'in_transit' } });
    expect(parseTrackingInput(`https://www.jygjgyl.com/index/tracknumber/track?nos=${IN_TRANSIT}`))
      .toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'jiayang', source: 'link' });
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for what is no waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(body('in-transit')))
      .mockResolvedValueOnce(reply(body('not-found')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toMatchObject({ known: true, lastActivityAt: expect.any(String) });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('JYGJ-0')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
    });
});

describe('Jiayang status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'jiayang', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(jiayangStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'jiayang', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
