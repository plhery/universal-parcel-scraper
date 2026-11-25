import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JytdTracker } from './adapter.js';
import { JYTD_ORIGIN, jytdClock, parseJytdPage, parseJytdTrack, splitJytdRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's JYTD page, and a number in a shape the tracker cannot hold.
const NUMBER = 'JYDIL5000307459YQ';
const UNKNOWN = 'ZZ0000000000ZZ';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

describe('Jieyi Tongda numbers', () => {
  it('leaves the waybill to detection and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://123.207.50.250:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'jytd' });
  });
});

describe('Jieyi Tongda tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new JytdTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER} `))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'IL' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JYTD_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(JYTD_ORIGIN).toBe('http://123.207.50.250:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'jytd', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('keeps Israel Post’s copied scans on their wall clocks and the line’s rows in China and Hong Kong on Beijing’s', () => {
    const result = parseJytdTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Final delivery', last_update: null, last_update_local: '2026-08-05T14:51:13',
      service_name: '以色列敏感', destination_country: 'IL',
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.canonical_tracking_number).toBeUndefined();
    const events = result.events!;
    // The two rows Israel Post words in Hebrew arrive as question marks alone and go.
    expect(events).toHaveLength(19);
    expect(events.some(({ description }) => description?.includes('?'))).toBe(false);
    expect(events.slice(0, 4).map(({ local_time: local, location, description, stage, time }) => [local, location, description, stage, time])).toEqual([
      ['2026-08-05T14:51:13', 'Savyon', 'Final delivery', 'delivered', undefined],
      ['2026-08-02T07:36:37', 'Savyon', 'Item received at delivery unit', 'in_transit', undefined],
      ['2026-07-29T09:52:43', 'Qiryat Ono Postman Unit', 'Item received at delivery unit', 'in_transit', undefined],
      ['2026-07-26T08:23:25', undefined, 'Parcel cleared', 'in_transit', undefined],
    ]);
    expect(events.find(({ description }) => description === 'Sorted to delivery point (after Customs)'))
      .toMatchObject({ local_time: '2026-07-26T08:23:25', location: 'Modiin eCommerce Sorting Center' });
    expect(events.find(({ description }) => description === 'Landed in Israel'))
      .toMatchObject({ local_time: '2026-07-25T05:02:39', location: 'TLV Airport', stage: 'in_transit' });
    expect(events.find(({ description }) => description === 'Arrive at destination airport'))
      .toMatchObject({ local_time: '2026-07-23T15:00:32', location: 'TLV' });
    expect(events.find(({ description }) => description === 'The flight has departed'))
      .toMatchObject({ time: '2026-07-22T15:55:23+08:00', location: 'HKG', stage: 'in_transit' });
    expect(events.find(({ description }) => description === 'Export clearance success'))
      .toMatchObject({ time: '2026-07-20T07:30:33+08:00', location: 'CN' });
    expect(events.find(({ provider_code: code }) => code === 'SHIPMENT'))
      .toMatchObject({ time: '2026-07-17T15:31:51+08:00', location: 'SHENZHEN', stage: 'in_transit' });
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL'))
      .toMatchObject({ time: '2026-07-17T11:04:13+08:00', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ time: '2026-07-15T13:21:23+08:00', stage: 'registered',
      description: 'The electronic information of the package has been received' });
    expect(result.planned_events ?? []).toEqual([]);
  });

  it('reads Israel Post’s manifest rows as notices that keep the stage of the scan before them', () => {
    const events = parseJytdTrack(fixture('delivered'), NUMBER, READ_AT)!.events!;
    expect(events.find(({ description }) => description === 'Cargo manifest received'))
      .toMatchObject({ local_time: '2026-07-22T06:51:52', stage: 'in_transit', stage_source: 'none' });
    expect(events.find(({ description }) => description === 'Parcel manifest received'))
      .toMatchObject({ local_time: '2026-07-18T14:12:44', stage: 'in_transit', stage_source: 'none' });
    expect(events.find(({ description }) => description === 'Parcel manifest received')).not.toHaveProperty('location');
  });

  it('drops a row lost to GBK and Israel Post’s unit codes, and reads a row’s clock by its kind code and place', () => {
    expect(splitJytdRow('?????', 'Qiryat Ono Postman Unit()')).toEqual({ content: '', location: '' });
    expect(splitJytdRow('Final delivery', 'Savyon()')).toEqual({ content: 'Final delivery', location: 'Savyon' });
    expect(splitJytdRow('Cargo manifest received', 'eCommerce System(5C-852)')).toEqual({ content: 'Cargo manifest received', location: '' });
    expect(splitJytdRow('Landed in Israel', 'TLV Airport(*CKS-0271)')).toEqual({ content: 'Landed in Israel', location: 'TLV Airport' });
    expect(splitJytdRow('Export clearance success', 'CN')).toEqual({ content: 'Export clearance success', location: 'CN' });
    expect([row('2026-08-05 14:51:13', 'Final delivery', 'Savyon()'), row('2026-07-23 15:00:32', 'Arrive at destination airport', 'TLV'),
      row('2026-07-22 15:55:23', 'The flight has departed', 'HKG'), row('2026-07-20 07:30:33', 'Export clearance success', 'CN'),
      row('2026-07-17 15:31:51', 'The package leaves the operation center', 'SHENZHEN', 'SHIPMENT'),
      row('2026-07-15 13:21:23', 'The electronic information of the package has been received')].map((each) => jytdClock(each)))
      .toEqual(['wall', 'wall', 'platform', 'platform', 'platform', 'platform']);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseJytdTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${JYTD_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseJytdPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JYD', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage ?? undefined);
    }
    expect(statusMapAnswer({ carrier: 'jytd', providerCode: 'ARRIVAL', description: 'The package has arrived at the operation center' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMap.gapNote?.(null, normalizeStatusWording('Cargo manifest received'))).toMatch(/notice|keeps the stage/);
  });
});
