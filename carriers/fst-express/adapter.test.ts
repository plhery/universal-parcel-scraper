import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FST_LOOKUP } from './adapter.js';
import { normalizeFstNumber, parseFst } from './parser.js';
import { fstStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's job, by its job number, the Australia Post consignment it carries and the sender's references.
const JOB = 'SAUZ012516953';
const CONSIGNMENT = '34LRU5071871';
const ARTICLE = '34LRU507187101000931506';
const REFERENCE = 'YY30310938723';
// Invented job numbers.
const OTHER = 'SAUZ900000000';
const UNKNOWN = 'SAUZ099999990';

type Row = Record<string, unknown>;
type Job = Record<string, unknown> & { podInfoDTOList: Row[] };
type Reply = { result_code: number; message: string; body: unknown };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const sampleJob = () => (fixture(CONSIGNMENT).body as Job[])[0]!;
/** The sample's job under an invented job number, with fields replaced. */
const job = (changes: Record<string, unknown> = {}): Job => ({ ...sampleJob(), jobno: OTHER, ...changes });
const reply = (...jobs: Job[]): Reply => ({ result_code: 0, message: '请求成功', body: jobs });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scans = (result: ReturnType<typeof parseFst>) => result.events!.map((event) => [event.time ?? event.local_time, event.description,
  event.location ?? null, event.provider_code ?? null, event.stage ?? null]);
/** A scan row as the tracker lists it, at Sydney's winter offset unless its instant is given. */
const row = (remark: string, scanTime: string, scanCode = 'O1', scanDatetime: unknown = Date.parse(`${scanTime.replace(' ', 'T')}+10:00`)): Row =>
  ({ remark, scanCode, scanDatetime, scanStation: 'DUBBO NSW', scanStatus: '交货其他状态', scanTime, scanUserName: 'sys' });

describe('FST Express numbers', () => {
  it('takes job numbers and references of letters and digits, in capitals', () => {
    expect(normalizeFstNumber(` ${JOB.toLowerCase()} `)).toBe(JOB);
    expect(normalizeFstNumber('0710tpx-4-is63337')).toBe('0710TPX4IS63337');
    for (const other of ['', 'SAUZ', 'ABCDEFGH', '12345', `SAUZ${'1'.repeat(37)}`, 'SAUZ01251/6953', 'SAUZ0125169531'.repeat(5)]) {
      expect(() => normalizeFstNumber(other), other).toThrow('FST Express tracks job numbers and references');
    }
  });
});

describe('FST Express tracking adapter', () => {
  it('posts the number as the tracker page’s form to the lookup behind it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(CONSIGNMENT)));
    await expect(carrier(fetcher).track({ number: JOB.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(FST_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }) });
    expect(init?.body).toBe(`jobNo=${JOB}&queryType=99`);
    expect(carrier(fetcher)).toMatchObject({ id: 'fst-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s not-found sentence as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, checks, failures, pages and moved routes apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({ message: 'Too Many Requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<html>Request blocked</html>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><script src="/sdwaf-test-resource.js"></script></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><title>Just a moment...</title></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<title>502 Bad Gateway</title>', 502))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.fstexpress.com.au/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<title>404 Not Found</title>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    // Only the not-found sentence is a missing job: a busy tracker or another code says nothing.
    expect(await answer(() => json({ result_code: 1, body: '系统繁忙', message: '系统繁忙' }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ ...fixture('not-found'), result_code: 2 }))).toMatchObject({ kind: 'indeterminate' });
    // A reply for another job says nothing about this one.
    expect(await answer(() => json(fixture(CONSIGNMENT)))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('FST Express replies', () => {
  it('reads the sample: its scans as instants at the offset shown, a repeated scan once, and the Australia Post hand-off', () => {
    const result = parseFst(fixture(CONSIGNMENT), CONSIGNMENT);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered - Left in a safe place',
      last_update: '2025-07-25T12:01:00+10:00', delivered_at: '2025-07-25T12:01:00+10:00', expected_delivery: null, destination_country: 'AU',
      delivery_carrier: 'australia-post', delivery_tracking_number: CONSIGNMENT,
    });
    expect(scans(result)).toEqual([
      ['2025-07-25T12:01:00+10:00', 'Delivered - Left in a safe place', 'DUBBO NSW', 'OK', 'delivered'],
      ['2025-07-25T08:59:00+10:00', 'Onboard for delivery', 'DUBBO NSW', 'O1', 'out_for_delivery'],
      ['2025-07-23T23:13:00+10:00', 'In transit to next facility', 'KEMPS CREEK NSW', 'O1', 'in_transit'],
      ['2025-07-23T18:08:00+10:00', 'Item processed at sorting facility', 'KEMPS CREEK NSW', 'O1', 'in_transit'],
      ['2025-07-23T15:43:00+10:00', 'Item processed at sorting facility', 'KEMPS CREEK NSW', 'O1', 'in_transit'],
      ['2025-07-22T16:32:00+10:00', 'Shipping information approved by Australia Post', 'CHULLORA NSW', 'O1', 'registered'],
      ['2025-07-22T16:01:00+10:00', 'Shipping information received by Australia Post', 'CHULLORA NSW', 'O1', 'registered'],
      ['2025-07-22T13:03:13+10:00', 'Arrived at FST Sort Facility', 'NSW Villawood', 'PU', 'in_transit'],
      ['2025-07-22T11:38:12+10:00', 'Consignment transferred to Last Mile Delivery Transport Hub', 'AUSYD', 'O3', 'in_transit'],
      ['2025-07-21T02:58:05+10:00', 'Consignment Cleared By Customs', 'AUSYD', 'OQ', 'in_transit'],
      ['2025-07-21T00:58:04+10:00', 'Consignment Held By Customs (CUS)', 'AUSYD', 'CI', 'customs'],
      ['2025-07-10T17:46:33+10:00', 'Label Created', 'Australia', 'LC', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    // Who scanned a row, and the parties, goods and charges, stay behind.
    expect(JSON.stringify(result)).not.toMatch(/Wiseway|007SYD|"sys"|YY30310938723|0710TPX/);
  });

  it('finds the job by its job number, its consignment and the sender’s references', () => {
    for (const number of [JOB, CONSIGNMENT, REFERENCE, '0710TPX-4-IS63337']) {
      expect(parseFst(fixture(CONSIGNMENT), number), number).toMatchObject({ current_stage: 'delivered', delivery_tracking_number: CONSIGNMENT });
    }
    // The same job listed twice is one job; two jobs under one reference are not.
    expect(parseFst(reply(job(), job()), OTHER)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseFst(reply(job(), job({ jobno: 'SAUZ900000001' })), CONSIGNMENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFst(reply(job()), 'SAUZ900000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a scan’s wall clock when its instant is missing or no offset away', () => {
    const rows = sampleJob().podInfoDTOList.slice(1);
    const at = (newest: Row) => parseFst(reply(job({ podInfoDTOList: [newest, ...rows] })), OTHER);
    const missing = at(row('Delivered - Left in a safe place', '2025-07-25 12:01:00', 'OK', null));
    expect(missing.events![0]).toMatchObject({ local_time: '2025-07-25T12:01:00', stage: 'delivered' });
    expect(missing.events![0]).not.toHaveProperty('time');
    expect(missing).toMatchObject({ last_update: null, last_update_local: '2025-07-25T12:01:00', current_stage: 'delivered' });
    expect(missing).not.toHaveProperty('delivered_at');
    // Seven minutes is no offset a clock has.
    const skewed = at(row('Delivered - Left in a safe place', '2025-07-25 12:01:00', 'OK', Date.parse('2025-07-25T11:54:00+10:00')));
    expect(skewed.events![0]).toEqual(expect.objectContaining({ local_time: '2025-07-25T12:01:00' }));
    // Sydney's summer offset, as the clocks show it.
    const summer = at(row('Delivered - Left in a safe place', '2026-01-05 09:30:00', 'OK', Date.parse('2026-01-05T09:30:00.250+11:00')));
    expect(summer).toMatchObject({ last_update: '2026-01-05T09:30:00+11:00', delivered_at: '2026-01-05T09:30:00+11:00' });
  });

  it('stages Australia Post’s relayed scans by their wording and leaves the rest to the shared rules', () => {
    const rows = sampleJob().podInfoDTOList.slice(1);
    const at = (newest: Row) => parseFst(reply(job({ podInfoDTOList: [newest, ...rows] })), OTHER);
    expect(at(row('Awaiting collection at DUBBO LPO', '2025-07-25 12:01:00'))).toMatchObject({ current_stage: 'ready_for_pickup',
      current_stage_source: 'wording:language' });
    expect(at(row('Attempted delivery', '2025-07-25 12:01:00', 'AR'))).toMatchObject({ current_stage: 'failed_attempt' });
    // A wording no rule reads leaves its scan without a stage, and the newest staged scan before it leads.
    const unread = at(row('Something odd', '2025-07-26 12:01:00'));
    expect(unread.events![0]).not.toHaveProperty('stage');
    expect(unread).toMatchObject({ last_status_text: 'Something odd', current_stage: 'out_for_delivery' });
    // A row without a remark shows its status name.
    expect(at({ ...row('', '2025-07-26 12:01:00', 'OK'), scanStatus: '已签收' }).events![0]).toMatchObject({ description: '已签收', stage: 'delivered' });
  });

  it('hands over to Australia Post only with its hub or scans, and only a number its rules take', () => {
    const own = sampleJob().podInfoDTOList.filter((scan) => !/Australia Post/.test(String(scan.remark)));
    const viaFst = { hubOutCode: '', hubOutName: '' };
    expect(parseFst(reply(job({ ...viaFst })), OTHER)).toMatchObject({ delivery_carrier: 'australia-post' });
    const unnamed = parseFst(reply(job({ ...viaFst, podInfoDTOList: own })), OTHER);
    expect(unnamed).not.toHaveProperty('delivery_carrier');
    expect(unnamed).not.toHaveProperty('delivery_tracking_number');
    // Without a consignment, the one piece's article number.
    expect(parseFst(reply(job({ refno: '', oldrefno: '' })), OTHER)).toMatchObject({ delivery_carrier: 'australia-post', delivery_tracking_number: ARTICLE });
    expect(parseFst(reply(job({ refno: 'REF123456' })), OTHER)).toMatchObject({ delivery_tracking_number: ARTICLE });
    const pieces = sampleJob().childTrack as Row[];
    expect(parseFst(reply(job({ refno: '', childTrack: [...pieces, { ...pieces[0], childNo: '34LRU507187102000931008' }] })), OTHER))
      .not.toHaveProperty('delivery_tracking_number');
  });

  it('reads a job without scans as listed, and a reply without a job as inconclusive', () => {
    expect(() => parseFst(reply(job({ podInfoDTOList: [] })), OTHER)).toThrow(expect.objectContaining({
      name: 'NoHistoryError', reason: 'listed', deliveryCarrier: 'australia-post', deliveryTrackingNumber: CONSIGNMENT }));
    expect(() => parseFst(reply(job({ podInfoDTOList: null })), OTHER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseFst(reply(), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps the parties out even when the tracker sends them', () => {
    const result = parseFst(reply(job({ sdName: 'Sender Person', reName: 'Recipient Person', reTel: '0400111222', reAddr: '1 Example Street',
      custName: 'Example Shop', reZip: '2830' })), OTHER);
    expect(JSON.stringify(result)).not.toMatch(/Person|0400111222|Example|2830/);
  });

  it('refuses a changed reply', () => {
    const scan = (changes: Row) => reply(job({ podInfoDTOList: [{ ...sampleJob().podInfoDTOList[0], ...changes }] }));
    const changed = [null, {}, { result_code: '0', body: [] }, { result_code: 0, body: {} }, { result_code: 0, body: [7] },
      { result_code: 0, body: [{ refno: OTHER }] }, reply(job({ podInfoDTOList: {} })), reply(job({ podInfoDTOList: [7] })),
      scan({ scanTime: '2025-07-25T12:01:00' }), scan({ scanTime: '2025-02-30 12:01:00' }), scan({ scanTime: '2025-07-25 24:00:00' }),
      scan({ scanDatetime: '1753408860000' }), scan({ scanDatetime: 1.5 }), scan({ remark: 7 }), scan({ scanCode: 'O K' }),
      reply(job({ childTrack: {} })), reply(job({ refno: '', childTrack: [7] })), reply(job({ destName: 7 }))];
    for (const payload of changed) {
      expect(() => parseFst(payload, OTHER), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('claims FST’s job numbers, and the consignment stays with Australia Post', () => {
    expect(detectCarrierMatch(JOB)).toMatchObject({ carrier: 'fst-express', confidence: 'high' });
    expect(detectCarrierMatch(CONSIGNMENT).candidates).toEqual(['australia-post']);
    expect(detectCarrierMatch(ARTICLE)).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
  });
});

describe('FST Express status vocabulary', () => {
  it('records every code and relayed wording with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'fst-express', providerCode: entry.code, description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(fstStage(entry.code, entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.stage('O1', 'something odd')).toBeUndefined();
    expect(statusMap.stage('ZZ', 'label created')).toBeUndefined();
    expect(statusMap.stage(null, 'label created')).toBeUndefined();
    expect(fstStage('ZZ', 'Something odd')).toBeNull();
  });
});
