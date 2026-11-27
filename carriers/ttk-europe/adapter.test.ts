import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import {
  adapter, normalizeTtkEuropeNumber, parseTtkEurope, parseTtkEuropeReply, TTK_EUROPE_LOOKUP, TtkEuropeTracker, ttkEuropeEnglishHalf,
} from './adapter.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
// The public sample's reply; the tests derive their other records from it.
const SAMPLE: string = fixture('handed-over').data[0].mail_no;
// Invented far from any range seen, as the not-found fixture's number.
const UNKNOWN = 'TE900000005GB';
interface SampleRecord { tracking: Array<Record<string, unknown>>; related_mail: string; mail_num: string; classify: string }
const changed =(edit: (record: SampleRecord) => void) => { const reply = fixture('handed-over'); edit(reply.data[0]); return reply; };
const json = (data: unknown, status = 200) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (op_time: string, op_desc: string) => ({ op_time, province: '', city: '', op_org_code: '', op_org_name: '', op_code: '', op_name: '', op_desc });

describe('TTK Europe tracking adapter', () => {
  it('asks the open lookup for the whole number once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('handed-over')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new TtkEuropeTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${SAMPLE.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TTK_EUROPE_LOOKUP}?mail_num=${SAMPLE}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' }) });
    expect(init!.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ttk-europe', step: 'direct', outcome: 'ok' }));
    expect(carrier(fetcher)).toMatchObject({ id: 'ttk-europe', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number that is not TTK Europe’s without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'TE900000006GB' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['', 'TE90000000GB', 'TE9000000055GB', 'RR900000005GB', 'TE900000005CN', 'TE900000005GB?', 'X'.repeat(70)]) {
      expect(() => normalizeTtkEuropeNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(normalizeTtkEuropeNumber(' te 900000005 gb ')).toBe(UNKNOWN);
  });

  it('reads the service’s "单号不存在" as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance'], [404, 'transport'], [302, 'transport']] as const)(
    'keeps HTTP %i apart from a missing parcel, without another request', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
        status === 302 ? new Response(null, { status, headers: { Location: '/' } }) : json(fixture('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN }, { budgetMs: 2000 })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('reads a verification page as a challenge and another page as a changed service', async () => {
    const answer = async (body: string) => carrier(vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(body, { headers: { 'Content-Type': 'text/html' } }))).track({ number: UNKNOWN }).catch((error: unknown) => error);
    expect(await answer('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>')).toMatchObject({ kind: 'challenge' });
    expect(await answer('<!DOCTYPE html><html><head><title>Tracking – Django REST framework</title></head></html>')).toMatchObject({ kind: 'schema' });
    expect(await answer('{"errno":0,')).toMatchObject({ kind: 'schema' });
    expect(await answer('')).toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    await expect(new TtkEuropeTracker({ fetcher: never }).fetch(UNKNOWN, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new TtkEuropeTracker({ fetcher }).fetch(UNKNOWN, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection, offers no number rule and hands Royal Mail nothing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('handed-over')));
    const answer = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'ttk-europe', number: SAMPLE });
    expect(answer).toMatchObject({ carrier: 'ttk-europe', source: 'ttk-europe' });
    expect(answer.result.events).toHaveLength(10);
    expect(detectCarrierMatch(SAMPLE).candidates ?? []).not.toContain('ttk-europe');
    expect(recognitionCandidates(SAMPLE).map((candidate) => candidate.carrier)).not.toContain('ttk-europe');
    expect(deliveryHandoff('ttk-europe', SAMPLE, parseTtkEurope(fixture('handed-over'), SAMPLE), 'CN')).toBeNull();
  });
});

describe('TTK Europe replies', () => {
  it('reads the English half of each row, its place and the clock of that place', () => {
    const result = parseTtkEurope(fixture('handed-over'), SAMPLE);
    expect(result).toMatchObject({ status: languageStageStatus('in_transit'), current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Handed over to final delivery courier', last_update: '2023-01-16T12:37:00+08:00', expected_delivery: null });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events!.map((event) => [event.local_time, event.time, event.time_zone, event.location, event.description, event.stage])).toEqual([
      ['2023-01-16T12:37:00', '2023-01-16T12:37:00+08:00', 'Asia/Shanghai', '中国 邮政', 'Handed over to final delivery courier', 'in_transit'],
      ['2023-01-16T12:37:00', '2023-01-16T12:37:00+08:00', 'Asia/Shanghai', '中国 广州海关', 'Customs clearance has completed', 'in_transit'],
      ['2023-01-16T02:09:00', '2023-01-16T02:09:00+08:00', 'Asia/Shanghai', '中国 广州海关', 'Customs clearance in process', 'customs'],
      ['2023-01-14T02:11:00', '2023-01-14T02:11:00+08:00', 'Asia/Shanghai', '中国 广州白云机场', 'Arrived in destination airport', 'in_transit'],
      ['2023-01-09T09:19:00', '2023-01-09T09:19:00+00:00', 'Europe/London', '英国 伦敦希思罗机场', 'Flight has departed', 'in_transit'],
      ['2023-01-06T16:38:00', '2023-01-06T16:38:00+00:00', 'Europe/London', '英国 伦敦希思罗机场', 'On route to Airport', 'in_transit'],
      ['2023-01-06T15:45:00', '2023-01-06T15:45:00+00:00', 'Europe/London', '英国 快件处理中心', 'Packed and ready to dispatch', 'in_transit'],
      // A notice without a place keeps its wall clock alone.
      ['2023-01-04T09:58:06', undefined, undefined, undefined, 'Repeat Consignee, Parcel will be exported in next shipment', 'pending'],
      ['2023-01-04T09:57:56', '2023-01-04T09:57:56+00:00', 'Europe/London', '英国主仓', 'Arrived in depot and prepared for export', 'accepted'],
      ['2023-01-03T12:47:51', '2023-01-03T12:47:51+00:00', 'Europe/London', '英国', 'Shipment Created', 'registered'],
    ]);
    expect(result.events!.filter((event) => event.time).every((event) => event.time_zone_basis === 'place')).toBe(true);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('original_description' in event))).toBe(true);
    // The domestic number is no China Post number its rules take, so no hand-off is named.
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
  });

  it('dates a British summer row on British Summer Time', () => {
    const result = parseTtkEurope(changed((record) => {
      record.tracking = [row('2023-07-03 12:47', `【英国】订单生成${SAMPLE} Shipment Created`)];
    }), SAMPLE);
    expect(result.events).toEqual([{ local_time: '2023-07-03T12:47:00', time: '2023-07-03T12:47:00+01:00', time_zone: 'Europe/London',
      time_zone_basis: 'place', location: '英国', description: 'Shipment Created', stage: 'registered', stage_source: 'carrier_map' }]);
  });

  it('puts the hand-over after customs’ release at the same minute, in either order', () => {
    const result = parseTtkEurope(changed((record) => { record.tracking = [record.tracking[1]!, record.tracking[0]!, ...record.tracking.slice(2)]; }), SAMPLE);
    expect(result.events!.slice(0, 2).map((event) => event.description)).toEqual(['Handed over to final delivery courier', 'Customs clearance has completed']);
    expect(result.last_status_text).toBe('Handed over to final delivery courier');
  });

  it('keeps the stage under a notice and leaves the staff member’s name out', () => {
    const result = parseTtkEurope(changed((record) => {
      record.tracking = [...record.tracking.slice(7, 9), row('2023-01-04 09:30:00', '【伯明翰仓】的收件员【Synthetic】已收件 Parcel Received'), record.tracking[9]!];
    }), SAMPLE);
    expect(result).toMatchObject({ current_stage: 'accepted', last_status_text: 'Repeat Consignee, Parcel will be exported in next shipment',
      last_update: null, last_update_local: '2023-01-04T09:58:06' });
    expect(result.events![2]).toMatchObject({ location: '伯明翰仓', description: 'Parcel Received', stage: 'accepted', time_zone: 'Europe/London' });
    expect(JSON.stringify(result)).not.toContain('Synthetic');
  });

  it('names China Post with the related number only when China Post’s rules take it whole', () => {
    const partnered = parseTtkEurope(changed((record) => { record.related_mail = 'rr900000005cn'; record.mail_num = 'RR900000005CN'; }), SAMPLE);
    expect(partnered).toMatchObject({ delivery_carrier: 'china-post', delivery_tracking_number: 'RR900000005CN' });
    expect(deliveryHandoff('ttk-europe', SAMPLE, partnered)).toMatchObject({ carrier: 'china-post', number: 'RR900000005CN' });
    for (const edit of [
      (record: SampleRecord) => { record.related_mail = 'RR900000005CN'; record.classify = 'shunfeng'; },
      (record: SampleRecord) => { record.related_mail = 'RR900000006CN'; record.mail_num = ''; },
      (record: SampleRecord) => { record.related_mail = SAMPLE; record.mail_num = SAMPLE; },
    ]) {
      const result = parseTtkEurope(changed(edit), SAMPLE);
      expect(result.delivery_carrier).toBeUndefined();
      expect(result.delivery_tracking_number).toBeUndefined();
    }
  });

  it('reads a record without a scan as listed, with its hand-off', () => {
    expect(() => parseTtkEurope(changed((record) => { record.tracking = []; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseTtkEurope(changed((record) => { record.tracking = []; record.related_mail = 'RR900000005CN'; }), SAMPLE))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', deliveryCarrier: 'china-post', deliveryTrackingNumber: 'RR900000005CN' }));
  });

  it('never reads an empty or changed answer as a missing parcel', () => {
    const kind = (payload: unknown) => { try { parseTtkEurope(payload, UNKNOWN); return 'ok'; } catch (error) { return (error as { kind: string }).kind; } };
    expect(kind({ errno: 0, data: [], msg: '请提交要查询的单号' })).toBe('schema');
    expect(kind({ errno: 0, data: [], msg: '' })).toBe('indeterminate');
    expect(kind({ errno: 1, data: [], msg: '单号不存在' })).toBe('indeterminate');
    expect(kind({ data: [], msg: '单号不存在' })).toBe('schema');
    expect(kind({ errno: 0, data: {}, msg: '单号不存在' })).toBe('schema');
    expect(kind([])).toBe('schema');
    // A record for another number, as for the related one, is no answer about this one.
    expect(kind(fixture('handed-over'))).toBe('indeterminate');
    expect(kind({ errno: 0, data: [1], msg: '' })).toBe('schema');
  });

  it('refuses records it cannot read', () => {
    const kind = (edit: (record: SampleRecord) => void, reply = changed(edit)) => {
      try { parseTtkEurope(reply, SAMPLE); return 'ok'; } catch (error) { return (error as { kind: string }).kind; }
    };
    expect(kind((record) => { record.tracking[0]!.op_time = '2023-02-30 12:00:00'; })).toBe('schema');
    expect(kind((record) => { record.tracking[0]!.op_time = '2023-01-16T12:37:00+08:00'; })).toBe('schema');
    expect(kind((record) => { record.tracking[0]!.op_time = 1673843820; })).toBe('schema');
    expect(kind((record) => { record.tracking[0]!.op_desc = ''; })).toBe('schema');
    expect(kind((record) => { record.tracking[0]!.op_desc = 'A'.repeat(600); })).toBe('schema');
    expect(kind((record) => { Object.assign(record, { tracking: 'none' }); })).toBe('schema');
    expect(kind((record) => { record.tracking = Array.from({ length: 201 }, () => record.tracking[0]!); })).toBe('schema');
    const twice = fixture('handed-over'); twice.data.push(twice.data[0]);
    expect(kind(() => {}, twice)).toBe('schema');
    expect(kind((record) => { record.tracking[0]!.op_time = '2023-01-16 12:37'; })).toBe('ok');
  });

  it('takes the English half after the Chinese, without a reference written against it', () => {
    expect(ttkEuropeEnglishHalf(`【英国】订单生成${UNKNOWN} Shipment Created`)).toBe('Shipment Created');
    expect(ttkEuropeEnglishHalf('重复收件人信息，包裹将移至下一批次发出 Repeat Consignee, Parcel will be exported in next shipment'))
      .toBe('Repeat Consignee, Parcel will be exported in next shipment');
    expect(ttkEuropeEnglishHalf('【中国 邮政】包裹已签收')).toBeNull();
    expect(ttkEuropeEnglishHalf('Parcel Received')).toBeNull();
    expect(parseTtkEurope(changed((record) => { record.tracking = [row('2023-01-20 10:00:00', '【中国 邮政】包裹已签收')]; }), SAMPLE).events![0])
      .toMatchObject({ description: '【中国 邮政】包裹已签收', location: '中国 邮政', time_zone: 'Asia/Shanghai' });
  });

  it('parses a reply’s text as the service sends it', () => {
    expect(parseTtkEuropeReply(JSON.stringify(fixture('handed-over')), SAMPLE).events).toHaveLength(10);
    expect(() => parseTtkEuropeReply(JSON.stringify(fixture('not-found')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('maps each wording it records to a stage', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'ttk-europe', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
      expect(STAGES).toContain(stage);
    }
    expect(statusMapAnswer({ carrier: 'ttk-europe', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
