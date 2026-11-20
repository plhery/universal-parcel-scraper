import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, RUNFORINT_API, RUNFORINT_PAGE, runforintRequest, RunforintTracker } from './adapter.js';
import { normalizeRunforintNumber, parseRunforint } from './parser.js';
import { runforintStage, statusMap } from './status.js';

const NUMBER = 'RF100500604555';
const UNKNOWN = 'RF999999999999';
const raw = (name: 'picked-up' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
interface Row { Status: unknown; Address: unknown; Info: unknown; DateTime: unknown; DateTimeZone: unknown }
interface Reply { Code: string; Message: string; TrackSysResponseDataList: { ShipmentNo: unknown; Destination: unknown; TrackSysInfoResponseList: Row[] }[];
  TrackSysResponseErrorList: unknown[] }
const fixture = (name: 'picked-up' | 'not-found') => JSON.parse(raw(name)) as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('picked-up'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const LIMITED = JSON.stringify({ Code: 'E1', Message: '超出请求次数限制！', TrackSysResponseDataList: [], TrackSysResponseErrorList: [] });

describe('Runforint tracking lookup', () => {
  it('posts the whole waybill, signed as the page signs it, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('picked-up')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new RunforintTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rf 1005-0060-4555 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('accepted');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(RUNFORINT_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Referer: `${RUNFORINT_PAGE}&key=${NUMBER}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    const sent = new URLSearchParams(String(init!.body));
    expect(JSON.parse(Buffer.from(sent.get('Data')!, 'base64').toString())).toEqual({ ShipmentNoList: [NUMBER] });
    expect(sent.get('SystemCode')).toBe('runforint');
    expect(sent.get('UserName')).toBe('');
    expect(sent.get('MessageId')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Math.abs(Number(sent.get('Timestamp')) - Date.now() / 1000)).toBeLessThan(60);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'runforint', step: 'direct', outcome: 'ok' }));
  });

  it('signs the fields with the page key', () => {
    const request = runforintRequest(NUMBER, 1_795_000_000_500, '00000000-0000-4000-8000-000000000000');
    expect(request.get('Timestamp')).toBe('1795000000');
    const signed = `Data=${request.get('Data')}&Key=5NbKkcXd2XpsjMX7NQwPcQkj4dBJTW5T&MessageId=00000000-0000-4000-8000-000000000000` // gitleaks:allow
      + '&SystemCode=runforint&Timestamp=1795000000&UserName=';
    expect(request.get('Signature')).toBe(createHash('md5').update(signed).digest('hex'));
    expect([...request.keys()]).toEqual(['Signature', 'SystemCode', 'Data', 'Timestamp', 'MessageId', 'UserName']);
  });

  it('reads the sample newest first, with wall clocks, status numbers and the destination', () => {
    const result = parseRunforint(fixture('picked-up'), NUMBER);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Package Picked up', last_update: null, last_update_local: '2026-11-19T23:08:11', expected_delivery: null,
      destination_country: 'US', events: [
        { local_time: '2026-11-19T23:08:11', location: 'Guangzhou', description: 'Package Picked up', provider_code: '500',
          stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-10-28T11:07:19', description: 'Parcel data received', provider_code: '300',
          stage: 'registered', stage_source: 'carrier_map' },
      ] });
    expect(JSON.stringify(result)).not.toMatch(/Airblox/);
  });

  it('keeps a stated offset and orders equal clocks newest last in the service order', () => {
    const result = parseRunforint(changed((r) => {
      const rows = r.TrackSysResponseDataList[0]!.TrackSysInfoResponseList;
      rows[0]!.DateTimeZone = '+08:00';
      rows.push({ ...rows[1]!, Info: 'Arrived at the sorting centre', Status: 600 });
    }), NUMBER);
    expect(result.events!.map((event) => event.description)).toEqual(['Arrived at the sorting centre', 'Package Picked up', 'Parcel data received']);
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-10-28T11:07:19+08:00' });
    expect(result.events!.at(-1)).not.toHaveProperty('local_time');
  });

  it('reads the unknown answer as not found, the request limit as a rate limit and anything else never as not found', async () => {
    expect(() => parseRunforint(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRunforint(JSON.parse(LIMITED), NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseRunforint({ ...fixture('not-found'), Message: '签名错误' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRunforint({ ...fixture('not-found'), Code: 'E9', Message: '系统繁忙' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRunforint(changed((r) => { r.TrackSysResponseDataList[0]!.ShipmentNo = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRunforint(changed((r) => { r.TrackSysResponseDataList = []; r.TrackSysResponseErrorList = [{ ShipmentNo: NUMBER, Error: '异常' }]; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRunforint(changed((r) => { r.TrackSysResponseDataList.push(r.TrackSysResponseDataList[0]!); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRunforint(changed((r) => { r.TrackSysResponseDataList[0]!.TrackSysInfoResponseList = []; }), NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseRunforint(changed((r) => { r.TrackSysResponseDataList[0]!.TrackSysInfoResponseList[0]!.DateTime = '2026-10-28T24:07:19'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRunforint(changed((r) => { r.TrackSysResponseDataList[0]!.TrackSysInfoResponseList[0]!.Status = '300'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new RunforintTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(LIMITED)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(raw('picked-up'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.runforint.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the site', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network')).mockResolvedValueOnce(response(raw('picked-up')));
    await expect(new RunforintTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'accepted' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeRunforintNumber('rf100500604555')).toBe(NUMBER);
    for (const number of ['100500604555', 'RF123456789', 'RF123456789012345', 'RF123456789CN', 'RX100500604555']) {
      expect(() => normalizeRunforintNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new RunforintTracker({ fetcher }).fetch('RF123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new RunforintTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'runforint', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the status numbers it has seen and leaves the rest to the wording rules', () => {
    expect(runforintStage('Parcel data received', '300')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(runforintStage('Package Picked up', '500')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(runforintStage('Delivered', '800')).toMatchObject({ stage: 'delivered' });
    expect(runforintStage('仓库作业', '650')).toBeNull();
    expect(statusMap.stage('300', 'Parcel data received')).toBe('registered');
  });
});
