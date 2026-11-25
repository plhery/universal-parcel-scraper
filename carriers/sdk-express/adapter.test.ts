import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SdkExpressTracker } from './adapter.js';
import { parseSdkExpressPage, parseSdkExpressTrack, SDK_EXPRESS_ORIGIN } from './parser.js';
import { sdkExpressEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's page, and a string in no shape the tracker issues.
const NUMBER = 'AG085660409CN';
const UNKNOWN = 'ZZ0000000000ZZ';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SDK Express numbers', () => {
  it('leaves its UPU S10 numbers to postal detection and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'china-post', confidence: 'high' });
    expect(parseTrackingInput(`http://8.129.105.101:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'sdk-express' });
  });
});

describe('SDK Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new SdkExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SDK_EXPRESS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(SDK_EXPRESS_ORIGIN).toBe('http://8.129.105.101:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'sdk-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('shows its Chinese and Russian rows in English, the platform’s on Beijing’s clock and the courier’s by their day', () => {
    const result = parseSdkExpressTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update_local: '2023-06-18',
      service_name: '俄邮宝(经济)', destination_country: 'RU',
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('planned_events');
    expect(result.events!.map(({ time, local_time: day, description, location, stage }) => [time ?? day, description, location, stage])).toEqual([
      ['2023-06-18', 'Delivered', 'Иркутск', 'delivered'],
      ['2023-06-18', 'Accepted in the recipient\'s city. Ready for collection', 'Иркутск', 'ready_for_pickup'],
      ['2023-06-18', 'In a transit city', 'Иркутск', 'in_transit'],
      ['2023-06-13', 'Sent to a transit city', 'Москва', 'in_transit'],
      ['2023-06-13', 'Accepted in the sender\'s city', 'Москва', 'in_transit'],
      ['2023-06-11T19:18:26+08:00', 'Arrived at the processing centre', '莫斯科', 'in_transit'],
      ['2023-06-09T16:54:55+08:00', 'Left the processing centre', '霍尔果斯', 'in_transit'],
      ['2023-06-02T11:02:33+08:00', 'Arrived at the processing centre', '霍尔果斯', 'in_transit'],
      ['2023-05-26T18:53:10+08:00', 'Left the processing centre', '广州', 'in_transit'],
      ['2023-05-25T09:52:45+08:00', 'Arrived at the processing centre', '广州', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/XM2LGG|1705520230524/);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseSdkExpressTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${SDK_EXPRESS_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseSdkExpressPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['AG08', `${NUMBER},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'true', data: {} }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'false', message: '系统繁忙' }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('maps every wording it lists, and any processing centre’s city, whatever the kind code', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.english)), entry.english).toBe(entry.stage);
    }
    expect(sdkExpressEnglish(null, '到达乌鲁木齐处理中心')).toBe('Arrived at the processing centre');
    expect(statusMapAnswer({ carrier: 'sdk-express', description: '离开莫斯科处理中心' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'sdk-express', description: 'Принят в городе получателя. Готов к выдаче' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'sdk-express', description: 'Вручен' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
