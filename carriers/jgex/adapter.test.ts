import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JgexTracker } from './adapter.js';
import { JGEX_ORIGIN, parseJgexPage, parseJgexTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's JGEX page, and an invented number.
const NUMBER = 'JG912050440363';
const UNKNOWN = 'JG000000000000';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JGEX numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://www.jgex.net:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'jgex' });
  });
});

describe('JGEX tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new JgexTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'US' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JGEX_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(JGEX_ORIGIN).toBe('http://www.jgex.net:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'jgex', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads USPS’s copies on their wall clocks, the line’s rows on Beijing’s and its script as planned steps', () => {
    const result = parseJgexTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, In/At Mailbox', last_update: null, last_update_local: '2025-01-23T17:35:00',
      service_name: '美线含电小包', destination_country: 'US',
    });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(22);
    // USPS's scans keep the minute USPS gave them, without a zone, and the place without its ZIP code.
    expect(events[0]).toMatchObject({ local_time: '2025-01-23T17:35:00', location: 'COLUMBIA, SC', stage: 'delivered' });
    expect(events[0]).not.toHaveProperty('time');
    expect(events.filter(({ description }) => description === 'In Transit to Next Facility' && !description.includes(','))
      .map(({ local_time: local }) => local)).toEqual(['2025-01-02', '2024-12-30', '2024-12-29T11:05:00', '2024-12-29T07:26:00']);
    // The line's own rows come to the second on Beijing's clock, its Chinese ones in English.
    expect(events.find(({ provider_code: code }) => code === 'SHIPMENT'))
      .toMatchObject({ time: '2024-12-21T00:31:44+08:00', location: 'SHANGHAI', description: 'Departed the collection point', stage: 'in_transit' });
    expect(events.at(-1)).toMatchObject({ time: '2024-12-16T11:24:30+08:00', description: 'Shipment information received', stage: 'registered' });
    // The platform's custom track rows, written in one batch ahead of their clocks, are planned steps.
    expect(result.planned_events?.map(({ description }) => description)).toEqual([
      'Leave Scan - Load car', 'The package is being sent to the airport.', 'The Package export customs clearance completed',
      'The package has left the Sender country', 'Arrive at the processing center', 'The package import customs clearance completed',
      'In Transit to Next Facility',
    ]);
    expect(result.written_ahead).toHaveLength(7);
    expect(JSON.stringify(result)).not.toContain('00000');
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseJgexTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${JGEX_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseJgexPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JG00', `${NUMBER},${UNKNOWN}`]) {
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
    expect(statusMapAnswer({ carrier: 'jgex', providerCode: 'SHIPMENT', description: '离开收寄点' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'jgex', description: 'Delivered, In/At Mailbox' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
