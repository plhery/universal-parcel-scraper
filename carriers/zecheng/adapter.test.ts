import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ZECHENG_API, ZECHENG_PAGE, ZechengTracker } from './adapter.js';
import { normalizeZechengNumber, parseZecheng } from './parser.js';
import { statusMap, zechengStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = 'ZCGJ0000000001CN';
const IN_TRANSIT = 'ZCGJ0000000002CN';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };

/** The fixture as the tracker sends it. */
const body = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
/** The fixture's array, decoded from the JSON string a known number's reply wraps it in. */
const fixture = (name: string) => {
  const parsed: unknown = JSON.parse(body(name));
  return (typeof parsed === 'string' ? JSON.parse(parsed) : parsed) as Item[];
};
// The tracker labels a known number's reply as JSON and an unknown number's as an HTML page.
const reply = (text: string, init: ResponseInit = {}) => new Response(text,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Zecheng HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body('in-transit'), { headers: { 'Content-Type': 'application/json' } }));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ZechengTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zcgj 0000-0000 02 cn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${ZECHENG_API}?nos=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'Accept-Language': 'zh-CN', Referer: `${ZECHENG_PAGE}?nos=${IN_TRANSIT}`, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zecheng', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Zecheng’s steps on Beijing time and stages them by their wording', () => {
    const result = parseZecheng(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Order information received', last_update: '2026-03-12T16:07:29+08:00',
      expected_delivery: null, destination_country: 'US' });
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([['2026-03-12T16:07:29+08:00', 'registered']]);
    expect(JSON.stringify(result)).not.toMatch(/中国|天/);
  });

  it('reads only the tracker’s unknown-number answer as not found, and binds the reply to the number asked', () => {
    expect(() => parseZecheng(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found', provider: 'Zecheng' }));
    const empty = fixture('in-transit');
    empty[0]!.details = [];
    expect(() => parseZecheng(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseZecheng(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Zecheng answered for another shipment' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (text: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text, init))).track({ number: UNKNOWN });
    await expect(lookup(body('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The same answer wrapped in a JSON string, as a known number's comes.
    await expect(lookup(JSON.stringify(body('not-found').trim()))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(body('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.zecwl.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>var arg1=\'00\';document.cookie="acw_sc__v2=00"</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>系统发生错误</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(JSON.stringify('<html><title>验证码</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(JSON.stringify(''))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    });

  it('rejects what is no waybill, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZCGJ00', 'SAMPLETRACKING', `ZCGJ${'0'.repeat(40)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeZechengNumber('zcgj 0000000002 cn')).toBe(IN_TRANSIT);
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

  it('routes a number filed or linked under Zecheng to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'zecheng' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'zecheng', source: 'zecheng', result: { current_stage: 'registered' } });
    expect(parseTrackingInput(`https://api.zecwl.com/index/tracknumber/track?nos=${IN_TRANSIT}`))
      .toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'zecheng', source: 'link' });
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for what is no waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(body('in-transit')))
      .mockResolvedValueOnce(reply(body('not-found')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toMatchObject({ known: true, lastActivityAt: expect.any(String) });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ZCGJ-0')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
    });
});

describe('Zecheng status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'zecheng', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(zechengStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'zecheng', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
