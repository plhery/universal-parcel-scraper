import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HdgjTracker } from './adapter.js';
import { HDGJ_ORIGIN, parseHdgjPage, parseHdgjTrack, splitHdgjRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's HDGJ page, and an invented number.
const NUMBER = 'HD000000103510YQ';
const UNKNOWN = 'HD000000000000YQ';
const USPS = '9500113052415242620349';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Bright East International numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://134.175.244.145:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'hdgj' });
  });
});

describe('Bright East International tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new HdgjTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', delivery_carrier: 'usps' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HDGJ_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(HDGJ_ORIGIN).toBe('http://134.175.244.145:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'hdgj', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('hands the parcel to USPS and reads USPS’s copies on their wall clocks, the line’s rows on Beijing’s', () => {
    const result = parseHdgjTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Individual Picked Up at Post Office', last_update: null, last_update_local: '2025-11-13T10:40:00',
      service_name: '皓东美国专线带电', destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: USPS,
    });
    const events = result.events!;
    expect(events).toHaveLength(15);
    // USPS's scans keep the minute USPS gave them, without a zone, its explanation after the arrow and the ZIP code cut.
    expect(events[0]).toMatchObject({ local_time: '2025-11-13T10:40:00', location: 'FRANKLIN, WI', stage: 'delivered' });
    expect(events[0]).not.toHaveProperty('time');
    // The hold at the post office comes once, though the tracker lists it with and without USPS's explanation.
    expect(events.filter(({ stage }) => stage === 'ready_for_pickup')).toEqual([
      expect.objectContaining({ local_time: '2025-10-01T08:14:00', description: 'Held at Post Office, At Customer Request', location: 'FRANKLIN, WI' }),
    ]);
    // The forwarder's row that leads with the country's code is placed there, on Beijing's clock.
    expect(events.find(({ description }) => description === 'Customs clearance completed'))
      .toMatchObject({ time: '2025-09-29T10:30:44+08:00', location: 'US', stage: 'in_transit' });
    expect(events.at(-1)).toMatchObject({ time: '2025-09-22T21:42:22+08:00', provider_code: 'ARRIVAL', stage: 'accepted' });
    // The platform's custom track rows, and the landing written hours ahead of its clock, are planned steps.
    expect(result.planned_events?.map(({ description, location }) => [description, location])).toEqual([
      ['Item outbound in sorting center', 'CN'], ['Departed from origin facility to airport', 'SZ'], ['Arrived at HK CENTER', 'HK'],
      ['Arrived at US Airport', 'US'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/00000|->/);
  });

  it('places a row that leads with its country’s code there, and cuts USPS’s explanation', () => {
    expect(splitHdgjRow('US,Customs clearance completed', '')).toEqual({ content: 'Customs clearance completed', location: 'US' });
    expect(splitHdgjRow('Departed USPS Regional Facility -> Your item departed our USPS facility.', 'CHICAGO IL DISTRIBUTION CENTER'))
      .toMatchObject({ content: 'Departed USPS Regional Facility', location: 'CHICAGO IL DISTRIBUTION CENTER' });
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseHdgjTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${HDGJ_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHdgjPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['HD00', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists, whatever the kind code', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'hdgj', providerCode: 'ARRIVAL', description: 'Arrival at the delivery point' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'hdgj', description: 'Held at Post Office, At Customer Request' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
