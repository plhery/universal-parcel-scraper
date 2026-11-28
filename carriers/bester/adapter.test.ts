import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BESTER_LOOKUP, BESTER_PAGE, BesterTracker, besterForm } from './adapter.js';
import { besterText, normalizeBesterNumber, parseBester } from './parser.js';
import { besterStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const TRANSFER = numbers.records[0]!.number;
const DELIVERED = numbers.records[1]!.number;
const UNKNOWN = 'SWE990481726';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Name = 'transfer' | 'delivered' | 'not-found';
const page = (name: Name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Bester Express tracking lookup', () => {
  it('posts the waybill page\'s form for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new BesterTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${DELIVERED} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BESTER_LOOKUP);
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({
      trackingNo: DELIVERED, user: 'T00195', code: '', siteid: '1', status: '2' });
    expect(init!.body).toBe(besterForm(DELIVERED));
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: `${BESTER_PAGE}?orderid=${DELIVERED}` } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bester', step: 'direct', outcome: 'ok' }));
  });

  it('dates every row on Taiwan\'s clock, newest first, and keeps the transfer centre\'s EMS line out of the text', () => {
    const result = parseBester(page('transfer'), TRANSFER, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '清關完成', last_update: '2017-08-08T19:08:00+08:00', last_update_local: '2017-08-08T19:08:00',
      expected_delivery: null, origin_country: 'TW' });
    // China Post tracks no domestic EMS waybill of thirteen digits, so the parcel names no delivery carrier.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('destination_country');
    const events = result.events!;
    expect(events.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2017-08-08T19:08:00', '轉運中心', '清關完成', 'in_transit'],
      ['2017-08-01T16:08:00', '轉運中心', '貨物抵達轉運倉庫', 'in_transit'],
      ['2017-08-01T16:08:00', '桃園分公司', '貨物發往目的地運送中', 'in_transit'],
      ['2017-07-31T17:07:00', '桃園分公司', '到達轉運倉庫理貨中', 'accepted'],
      ['2017-07-31T11:07:00', '桃園分公司', '安排收取貨件', 'registered'],
    ]);
    expect(events[0]).toEqual({ time: '2017-08-08T19:08:00+08:00', time_zone: 'Asia/Taipei', time_zone_basis: 'carrier',
      local_time: '2017-08-08T19:08:00', location: '轉運中心', description: '清關完成',
      original_description: '清關完成 转运单：EMS:9975104606094', stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('reads the signed-for row as the delivery', () => {
    const result = parseBester(page('delivered'), DELIVERED, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2021-05-25T17:05:00+08:00',
      last_status_text: '貨物已簽收,期盼有機會能再為你服務' });
    expect(result).not.toHaveProperty('origin_country');
    expect(result.events!.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'customs', 'in_transit', 'accepted', 'registered']);
    expect(result.events!.every((event) => event.location === '轉運中心' && event.time_zone === 'Asia/Taipei')).toBe(true);
  });

  it('names China Post as the delivery carrier only for an EMS number its own rules take', () => {
    const body = page('transfer').replaceAll('EMS:9975104606094', 'EMS:EA123456785CN');
    expect(parseBester(body, TRANSFER, READ_AT)).toMatchObject({ origin_country: 'TW', destination_country: 'CN',
      delivery_carrier: 'china-post', delivery_tracking_number: 'EA123456785CN' });
    const other = page('transfer').replaceAll('EMS:9975104606094', '順豐:EA123456785CN');
    expect(parseBester(other, TRANSFER, READ_AT)).not.toHaveProperty('delivery_carrier');
  });

  it('leaves a row Taiwan\'s clock would date after the lookup its wall clock alone', () => {
    const result = parseBester(page('delivered'), DELIVERED, Date.parse('2021-05-25T08:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2021-05-25T15:05:00+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2021-05-25T17:05:00' });
  });

  it('takes phones and signers out of a row\'s text', () => {
    expect(besterText('貨物已簽收，簽收人：某某')).toBe('貨物已簽收');
    expect(besterText('貨物運務員遞送中 0912-345-678')).toBe('貨物運務員遞送中');
    expect(besterText('請聯繫 13800000000')).toBe('請聯繫');
  });

  it('reads the nodata block as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseBester(page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The waybill page carries its own nodata block before its script asks for the rows: it is not an answer.
    const whole = `<!DOCTYPE html><html><head><title>运单追踪</title></head><body>${page('not-found')}</body></html>`;
    expect(() => parseBester(whole, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBester('<div class="nodata"><div class="title">请稍后再试</div></div>', UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBester('<div class="boxs"><ul></ul></div>', TRANSFER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = page('transfer').replace('2017-AUG-08 19:08', '2017-FEB-30 19:08');
    expect(() => parseBester(clock, TRANSFER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBester(page('transfer').replace('2017-AUG-08 19:08', '2017-08-08 19:08'), TRANSFER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new BesterTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('not-found'), { status: 500 })).rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.exbtr.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"status":0,"info":"error"}', { headers: { 'content-type': 'application/json' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeBesterNumber(TRANSFER.toLowerCase())).toBe(TRANSFER);
    expect(normalizeBesterNumber(DELIVERED)).toBe(DELIVERED);
    for (const number of ['12345', 'SWEABCDEF', `S${'1'.repeat(30)}`, 'SWE17/0000490', '']) {
      expect(() => normalizeBesterNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BesterTracker({ fetcher }).fetch('SWE1&user=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new BesterTracker({ fetcher }).fetch(TRANSFER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'bester', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps each text in statuses.json, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, '新的狀態')).toBeUndefined();
    expect(besterStage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(besterStage('新的狀態')).toBeNull();
  });
});
