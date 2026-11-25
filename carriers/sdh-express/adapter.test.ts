import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SdhExpressTracker } from './adapter.js';
import { parseSdhExpressPage, parseSdhExpressTrack, SDH_EXPRESS_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's page, and a string in no shape the tracker issues.
const NUMBER = 'SDH0095088014';
const UNKNOWN = 'ZZ0000000000ZZ';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Lightning Monkey numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://182.254.152.160:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'sdh-express' });
  });
});

describe('Lightning Monkey tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('in-transit')));
    await expect(new SdhExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SDH_EXPRESS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(SDH_EXPRESS_ORIGIN).toBe('http://182.254.152.160:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'sdh-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the rows on Beijing’s clock and lists the steps written ahead as planned', () => {
    const result = parseSdhExpressTrack(fixture('in-transit'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The post office is in operation', last_update: '2026-05-26T02:18:23+08:00',
      service_name: '美猴敏感专线', destination_country: 'US',
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    const events = result.events!;
    expect(events.map(({ time, description }) => [time, description])).toEqual([
      ['2026-05-26T02:18:23+08:00', 'The post office is in operation'],
      ['2026-05-24T01:42:09+08:00', 'The delivery company is processing it'],
      ['2026-05-21T02:15:05+08:00', 'Shipment onforwarded by delivery facility'],
      ['2026-05-19T05:37:06+08:00', 'SHIPMENT RECEIVED BY DELIVERY FACILITY'],
      ['2026-05-17T02:48:05+08:00', 'CONSIGNMENT RECEIVED BY OVERSEAS FORWARDER'],
      ['2026-05-14T03:37:48+08:00', 'custom clearance completed'],
      ['2026-05-07T16:49:17+08:00', 'Cargo leaving the operation center'],
      ['2026-05-07T13:35:55+08:00', 'Arrive at the delivery point'],
      ['2026-04-25T11:40:56+08:00', 'Shipment information received'],
    ]);
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL')).toMatchObject({ location: 'Hangzhou', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ stage: 'registered' });
    // The platform's custom track rows, and the flight's rows written days before their clocks, are steps, not scans.
    expect(result.planned_events).toEqual([
      { time: '2026-05-08T16:49:17+08:00', description: 'Arrive at the sorting center for operation and transfer', location: 'HANGZHOU', stage: 'in_transit' },
      { time: '2026-05-09T16:49:17+08:00', description: 'arrive at international airport to abroad', location: 'China', stage: 'in_transit' },
      { time: '2026-05-09T18:49:17+08:00', description: 'Shipment started the customs clearance process at origin', location: 'China', stage: 'in_transit' },
      { time: '2026-05-10T08:29:20+08:00', description: 'departed from airport of origin', location: 'HKG', stage: 'in_transit' },
      { time: '2026-05-12T03:29:52+08:00', description: 'arrived at airport of destination', location: 'LAX', stage: 'in_transit' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/AHMLN|RTI22/);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseSdhExpressTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${SDH_EXPRESS_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseSdhExpressPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('in-transit')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SDH00', `${NUMBER},${UNKNOWN}`]) {
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
    expect(statusMapAnswer({ carrier: 'sdh-express', providerCode: 'ARRIVAL', description: 'Arrive at the delivery point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'sdh-express', description: 'The post office is in operation' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
