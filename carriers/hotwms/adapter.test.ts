import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HOTWMS_API, HOTWMS_SITE, HotwmsTracker, hotwmsLookupUrl } from './adapter.js';
import { normalizeHotwmsNumber, parseHotwms } from './parser.js';
import { hotwmsStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = '9999999999999999999';
type Reply = { ts: number; body: { tn: string; steps: { place: string; desc: string; ts: number }[] } };
const text = (name: 'handed-over' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'handed-over' | 'not-found') => JSON.parse(text(name)) as Reply;
const withSteps = (map: (step: Reply['body']['steps'][number]) => Reply['body']['steps'][number]) => {
  const payload = json('handed-over');
  return { ...payload, body: { ...payload.body, steps: payload.body.steps.map(map) } };
};
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('HOTWMS tracking lookup', () => {
  it('asks the service for the whole number through the supplied transport, with the page\'s origin', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('handed-over')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 6)} ${NUMBER.slice(6, 12)}-${NUMBER.slice(12)}`;
    const result = await new HotwmsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.events).toHaveLength(14);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(hotwmsLookupUrl(NUMBER));
    expect(String(url)).toBe(`${HOTWMS_API}${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Origin: HOTWMS_SITE, Referer: `${HOTWMS_SITE}/trace.html`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hotwms', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, each step at the instant it gives, with EMS\'s hand-over in the wording', () => {
    const result = parseHotwms(json('handed-over'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '已交付末段 [EMS]: 9761047615897', last_update: '2020-06-05T04:30:00Z', expected_delivery: null });
    const events = result.events!;
    expect(events.map((event) => event.description)).toEqual(['已交付末段 [EMS]: 9761047615897', '海关放行', '根据海关政策查验征税',
      '清关中', '已提货', '待提货', '航班已到港', '航班已离港', '航班已预定', '已出库', '已装袋', '清关单已创建', '清关袋已就绪', '已入库']);
    expect(events[0]).toEqual({ time: '2020-06-05T04:30:00Z', description: '已交付末段 [EMS]: 9761047615897', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events[3]).toEqual({ time: '2020-06-01T09:40:00Z', description: '清关中', stage: 'customs', stage_source: 'carrier_map' });
    expect(events[5]).toMatchObject({ description: '待提货', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events[13]).toEqual({ time: '2020-05-24T02:37:32Z', description: '已入库', stage: 'accepted', stage_source: 'carrier_map' });
    // Bagged and declared at one instant: the reply lists the bagging first, as the newer.
    expect(events[10]!.time).toBe(events[11]!.time);
    expect(events.every((event) => !('local_time' in event) && !('location' in event))).toBe(true);
    // EMS's thirteen-digit domestic number is no number China Post's rules or adapter take.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('names China Post for the last leg only when the step says EMS and China Post\'s rules take its number', () => {
    const ems = (desc: string) => withSteps((step) => (step.desc.startsWith('已交付末段') ? { ...step, desc } : step));
    expect(parseHotwms(ems('已交付末段 [EMS]: EA000000005CN'), NUMBER))
      .toMatchObject({ delivery_carrier: 'china-post', delivery_tracking_number: 'EA000000005CN', current_stage: 'in_transit' });
    for (const desc of ['已交付末段 [顺丰]: EA000000005CN', '已交付末段 [EMS]', '已交付末段 [EMS]: EA000000006CN']) {
      const result = parseHotwms(ems(desc), NUMBER);
      expect(result, desc).not.toHaveProperty('delivery_carrier');
      expect(result.events![0], desc).toMatchObject({ description: desc, stage: 'in_transit', stage_source: 'carrier_map' });
    }
  });

  it('keeps a step\'s place when it gives one, and drops a step without wording', () => {
    const placed = withSteps((step) => (step.desc === '航班已离港' ? { ...step, place: 'Los Angeles' } : step.desc === '已出库' ? { ...step, desc: ' ' } : step));
    const result = parseHotwms(placed, NUMBER);
    expect(result.events).toHaveLength(13);
    expect(result.events!.find((event) => event.description === '航班已离港')).toMatchObject({ location: 'Los Angeles' });
    const blank = withSteps((step) => ({ ...step, desc: '' }));
    expect(() => parseHotwms(blank, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the empty answer for the number asked as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHotwms(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // An empty answer, or a history, for another number is no answer for this one.
    expect(() => parseHotwms(json('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHotwms(json('handed-over'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The page shows the service's error message for these.
    expect(() => parseHotwms({ errCode: '500', errMsg: '服务器遇到错误，无法完成请求' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHotwms({ ...json('not-found'), errorMessage: 'busy' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHotwms({ ts: 1, body: { tn: NUMBER } }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHotwms({ message: 'Missing Authentication Token' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHotwms(withSteps((step) => ({ ...step, ts: String(step.ts) as never })), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHotwms(withSteps((step) => ({ ...step, ts: 1_591_331 })), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new HotwmsTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new HotwmsTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(text('not-found'))) }).fetch(UNKNOWN, { budgetMs: 5000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('{"message":"Missing Authentication Token"}', { status: 403 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.hotwms.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeHotwmsNumber(` ${NUMBER} `)).toBe(NUMBER);
    expect(normalizeHotwmsNumber('hot123456')).toBe('HOT123456');
    for (const number of ['12345', 'ABCDEFGHIJ', '1'.repeat(41), '23070830/09402859017', '230708?3009', '']) {
      expect(() => normalizeHotwmsNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HotwmsTracker({ fetcher }).fetch('230708/3009')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new HotwmsTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hotwms', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('leaves the bare nineteen digits to no rule', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
  });

  it('maps the steps by their wording, the hand-over without its carrier and number, else by the shared wording rules', () => {
    expect(hotwmsStage('已入库')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(hotwmsStage('根据海关政策查验征税')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(hotwmsStage('已交付末段 [EMS]: 9761047615897')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage(null, '已交付末段 [ems]: 9761047615897')).toBe('in_transit');
    expect(statusMap.stage(null, '海关放行')).toBe('in_transit');
    expect(statusMap.stage(null, '已交付末段 [顺丰]: 123456789012')).toBe('in_transit');
    expect(statusMap.stage(null, '已交付')).toBeUndefined();
    expect(hotwmsStage('已签收')).toMatchObject({ stage: 'delivered' });
  });
});
