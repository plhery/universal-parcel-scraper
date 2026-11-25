import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WokexpTracker } from './adapter.js';
import { isWokexpPosteRow, parseWokexpPage, parseWokexpTrack, WOKEXP_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's Wokexp page, and an invented number.
const NUMBER = 'WLYK0000082627';
const UNKNOWN = 'WLYK0000000000';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Wokexp numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://www.wokexp.cn:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'wokexp' });
  });
});

describe('Wokexp tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new WokexpTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'IT' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${WOKEXP_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(WOKEXP_ORIGIN).toBe('http://www.wokexp.cn:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'wokexp', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the line’s rows on Beijing’s clock and Poste Italiane’s on Italy’s wall clock, each scan once', () => {
    const result = parseWokexpTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Consegnata, la spedizione è stata consegnata', last_update: null, last_update_local: '2025-07-08T13:55:51',
      service_name: '通用渠道', destination_country: 'IT',
    });
    // The record's invoice number is Poste Italiane's, but the platform does not give it as a transfer number.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(12);
    expect(events.slice(0, 4).map(({ local_time: local, description, time }) => [local, description, time])).toEqual([
      ['2025-07-08T13:55:51', 'Consegnata, la spedizione è stata consegnata', undefined],
      ['2025-07-08T10:02:48', 'In consegna', undefined],
      ['2025-07-07T14:04:51', 'In transito', undefined],
      ['2025-07-04T13:20:00', 'In transito, la spedizione è in transito', undefined],
    ]);
    expect(events[1]).toMatchObject({ stage: 'out_for_delivery', location: 'Montecorvino Rovella (SA)' });
    expect(events.find(({ location }) => location === 'AMSTERDAM'))
      .toMatchObject({ time: '2025-06-27T14:31:00+08:00', description: 'Arrive at the destination airport' });
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL'))
      .toMatchObject({ time: '2025-06-21T19:37:24+08:00', stage: 'accepted' });
    expect(result.planned_events ?? []).toEqual([]);
  });

  it('tells Poste Italiane’s rows from the line’s', () => {
    expect(['In transito', 'In consegna, la spedizione è in consegna', 'Consegnata, la spedizione è stata consegnata'].every(isWokexpPosteRow)).toBe(true);
    expect(['IN transit to warehouse', 'Arrive at the destination airport', 'Shipment received and processed at original facility'].some(isWokexpPosteRow))
      .toBe(false);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseWokexpTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${WOKEXP_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseWokexpPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['WL00', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists, whatever the warehouse’s kind code', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'wokexp', providerCode: 'ARRIVAL', description: 'Shipment received and processed at original facility' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'wokexp', description: 'In consegna' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
