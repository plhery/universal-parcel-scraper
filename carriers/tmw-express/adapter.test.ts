import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, normalizeTmwNumber, parseTmw, parseTmwReply, TMW_LOOKUP, TmwExpressTracker, withoutContacts } from './adapter.js';
import { statusMap, tmwStepWording } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// A synthetic number: no public page shows a TMW Express order.
const NUMBER = 'TMW0000001';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const changed = (edit: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('synthetic-order'); edit(reply); return reply; };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const step = (stepno: unknown, steptime: unknown, steptype: unknown = 'Synthetic step') => ({ stepno, steptype, steptime });
const record = (ftime: unknown, context: unknown) => ({ time: ftime, ftime, context });
const fail = (msg: string) => ({ msg, code: 'fail' });

describe('TMW Express tracking adapter', () => {
  it('posts the whole number once, as the tracker does, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('synthetic-order')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new TmwExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TMW_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', body: `docnewcode=${NUMBER}`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1' }) });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tmw-express', step: 'direct', outcome: 'ok' }));
    expect(carrier(fetcher)).toMatchObject({ id: 'tmw-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number the tracker does not take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'TMW' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['', 'TMW01', 'ABCDEFGHIJ', 'TMW 000-1/', 'TMW0000001?', `${'A'.repeat(40)}1`, 'X'.repeat(70)]) {
      expect(() => normalizeTmwNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    for (const number of [NUMBER, 'tmw0000001', '123456', 'TMW-0000-001']) expect(normalizeTmwNumber(` ${number} `)).toMatch(/^[A-Z0-9]+$/);
  });

  it('reads the service’s "该订单不存在" as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [404, 'transport'], [302, 'transport']] as const)(
    'keeps HTTP %i apart from a missing order, without another request', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
        status === 302 ? new Response(null, { status, headers: { Location: '/' } }) : json(fail('该订单不存在'), status, { 'retry-after': '60' }));
      await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 2000 })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('reads a verification page as a challenge and another page as a changed service', async () => {
    const answer = async (body: string) => carrier(vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(body, { headers: { 'Content-Type': 'text/html' } }))).track({ number: NUMBER }).catch((error: unknown) => error);
    expect(await answer('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>')).toMatchObject({ kind: 'challenge' });
    expect(await answer('<html><head><title>滑动验证</title></head></html>')).toMatchObject({ kind: 'challenge' });
    expect(await answer('<!DOCTYPE html><html><head><title>TMW Express</title></head><body><div id="app"></div></body></html>')).toMatchObject({ kind: 'schema' });
    expect(await answer('')).toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    await expect(new TmwExpressTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new TmwExpressTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('synthetic-order')));
    const answer = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'tmw-express', number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'tmw-express', source: 'tmw-express' });
    expect(answer.result.events).toHaveLength(10);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('tmw-express');
    expect(recognitionCandidates(NUMBER).map((candidate) => candidate.carrier)).not.toContain('tmw-express');
  });
});

describe('TMW Express replies', () => {
  it('reads the steps and the courier’s rows newest first, as wall clocks, without the people in them', () => {
    const result = parseTmw(fixture('synthetic-order'), NUMBER);
    expect(result).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording/),
      last_status_text: '【合成市】您的快件已签收。', last_update: null, last_update_local: '2026-03-10T15:02:11', expected_delivery: null });
    expect(result.provider_code).toBeUndefined();
    expect(result.events!.map((event) => [event.local_time, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-03-10T15:02:11', '【合成市】您的快件已签收。', undefined, 'delivered'],
      ['2026-03-10T08:31:40', '【合成市】正在为您派件', undefined, undefined],
      ['2026-03-09T21:14:03', '快件已到达【合成转运中心】', undefined, 'in_transit'],
      ['2026-03-08T18:09:57', '【合成市】已揽收', undefined, undefined],
      ['2026-03-07T16:45:00', '等待国内派送', '99', 'in_transit'],
      ['2026-03-06T11:05:00', '中国海关审完单，过机理货中', '12', 'customs'],
      ['2026-03-05T14:20:00', '已抵达中国海关监管仓库，清关中', '10', 'customs'],
      // A step at midnight was picked as a day alone.
      ['2026-03-04', '航班中转', '8', 'in_transit'],
      ['2026-03-03T08:30:00', '珀斯机场海关揽收', '6', 'in_transit'],
      ['2026-03-02T10:00:00', '包裏分拣完毕，等待机场揽收', '4', 'accepted'],
    ]);
    expect(result.events!.filter((event) => event.provider_code).every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/合成名|13800138000|Synthetic hidden|签收人/);
  });

  it('leads with the newest step before the courier answers, and keeps one clock’s order', () => {
    const steps = changed((reply) => { reply.data.logisticsrecordList = []; });
    expect(parseTmw(steps, NUMBER)).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', provider_code: '99',
      last_status_text: '等待国内派送', last_update_local: '2026-03-07T16:45:00' });
    const tied = changed((reply) => {
      reply.data.airStepList = [step(12, '2026-03-06 11:05:00', '中国海关审完单，过机理货中'), step(10, '2026-03-06 11:05:00', '已抵达中国海关监管仓库，清关中')];
      reply.data.logisticsrecordList = [record('2026-03-06 11:05:00', '已发出'), record('2026-03-06 11:05:00', '已收件')];
    });
    expect(parseTmw(tied, NUMBER).events!.map((event) => event.provider_code ?? event.description)).toEqual(['已发出', '已收件', '12', '10']);
    // A step the script does not name keeps its code and the reply's wording, and stays unstaged.
    const unnamed = parseTmw(changed((reply) => { reply.data.airStepList = [step('14', '2026/3/8 9:05')]; reply.data.logisticsrecordList = null; }), NUMBER);
    expect(unnamed.events).toEqual([{ local_time: '2026-03-08T09:05:00', description: 'Synthetic step', provider_code: '14' }]);
    expect(unnamed).toMatchObject({ status: 'unknown', provider_code: '14' });
    expect(unnamed.current_stage).toBeUndefined();
  });

  it('checks the number when the reply names one', () => {
    expect(parseTmw(changed((reply) => { reply.data.docnewcode = 'tmw-0000001'; }), NUMBER).events).toHaveLength(10);
    for (const reply of [changed((reply) => { reply.data.docnewcode = 'TMW0000002'; }), changed((reply) => { reply.data.airStepList[2].docnewcode = 'TMW0000002'; })]) {
      expect(() => parseTmw(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('reads a known order with nothing to show as no history', () => {
    for (const reply of [
      changed((reply) => { reply.data.airStepList = []; reply.data.logisticsrecordList = []; }),
      changed((reply) => { reply.data.airStepList = reply.data.airStepList.slice(0, 2); reply.data.logisticsrecordList = null; }),
      { msg: '', code: 'success', data: {} },
    ]) expect(() => parseTmw(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
  });

  it('keeps the failures that say nothing about the order apart from a missing one', () => {
    expect(() => parseTmwReply(JSON.stringify(fixture('not-found')), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTmw(fail('未传递订单号'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const reply of [fail('系统繁忙'), fail(''), { code: 'fail' }, { ...fail('该订单不存在'), data: { airStepList: [] } }]) {
      expect(() => parseTmw(reply, NUMBER), JSON.stringify(reply)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('refuses a changed reply', () => {
    for (const reply of [
      changed((reply) => { reply.data.airStepList[2].steptime = '2026-13-02 10:00:00'; }),
      changed((reply) => { reply.data.airStepList[2].steptime = '02/03/2026 10:00'; }),
      changed((reply) => { reply.data.airStepList[2].steptime = '2026-03-02 24:00:00'; }),
      changed((reply) => { reply.data.airStepList[2].steptime = 1772445600000; }),
      changed((reply) => { reply.data.airStepList[2].stepno = 'four'; }),
      changed((reply) => { reply.data.airStepList[2].stepno = null; }),
      changed((reply) => { reply.data.airStepList[2].steptype = ''; }),
      changed((reply) => { reply.data.logisticsrecordList[0].context = ''; }),
      changed((reply) => { reply.data.logisticsrecordList[0] = record('', '已签收'); }),
      changed((reply) => { reply.data.logisticsrecordList[0] = record('1999-03-10 15:02:11', '已签收'); }),
      changed((reply) => { reply.data.airStepList = {}; }),
      changed((reply) => { reply.data.airStepList = ['4']; }),
      changed((reply) => { reply.data.logisticsrecordList = Array(301).fill(record('2026-03-10 15:02:11', '已签收')); }),
      changed((reply) => { reply.code = 'ok'; }),
      changed((reply) => { reply.data = []; }),
      changed((reply) => { reply.data = null; }),
      null, [], 'order', {}, { code: 200, data: {} },
    ]) expect(() => parseTmw(reply, NUMBER), JSON.stringify(reply)?.slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes out the people and phone numbers of a courier’s row, and nothing else', () => {
    for (const [row, kept] of [
      ['【合成市】您的快件已签收，签收人：本人。', '【合成市】您的快件已签收。'],
      ['【合成市】派件员：合成名 电话：13800138000 正在为您派件', '【合成市】正在为您派件'],
      ['【合成市】快递员【合成名】已揽收', '【合成市】已揽收'],
      ['快件已由派送员（合成名，手机 138****8000）派送中', '快件已由派送中'],
      ['如有疑问请联系派件员，电话：021-12345678，谢谢', '如有疑问请联系派件员，谢谢'],
      ['派件员是合成名，手机 138 0013 8000', ''],
      ['快件已到达【合成转运中心】', '快件已到达【合成转运中心】'],
      ['SF Express 已揽收', 'SF Express 已揽收'],
      ['已签收，签收人凭取货码签收。', '已签收，签收人凭取货码签收。'],
    ] as const) expect(withoutContacts(row), row).toBe(kept);
  });

  it('answers each step statuses.json records by its stage', () => {
    expect(statuses.entries).toHaveLength(7);
    for (const { code, wording, stage } of statuses.entries) {
      expect(tmwStepWording(code)).toBe(wording);
      expect(statusMap.stage(code, wording)).toBe(stage);
      expect(statusMapAnswer({ carrier: 'tmw-express', providerCode: code, description: wording }), `${code} ${wording}`).toEqual({ kind: 'mapped', stage });
      expect(STAGES).toContain(stage);
    }
    expect(statusMap.stage('0', 'Synthetic hidden step')).toBeUndefined();
    expect(statusMap.stage(null, '已签收')).toBeUndefined();
  });
});
