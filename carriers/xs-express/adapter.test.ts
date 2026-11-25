import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, XsExpressTracker } from './adapter.js';
import { parseXsExpressPage, parseXsExpressTrack, splitXsExpressRow, XS_EXPRESS_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's page, USPS's number its record holds, and a string
// in no shape the tracker issues.
const NUMBER = 'XSECN2201403703YQ';
const USPS = '92144902816707870008330317';
const UNKNOWN = 'ZZ0000000000ZZ';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Xinshu Logistics numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://tms.xs-exp.com:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'xs-express' });
  });
});

describe('Xinshu Logistics tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new XsExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', delivery_carrier: 'usps' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${XS_EXPRESS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(XS_EXPRESS_ORIGIN).toBe('http://tms.xs-exp.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'xs-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('hands the parcel to USPS and reads USPS’s copies on their wall clocks, the line’s rows on Beijing’s', () => {
    const result = parseXsExpressTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, In/At Mailbox', last_update: null, last_update_local: '2022-09-07T11:12:00',
      service_name: '美国专线挂号(经济带电)', destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: USPS,
    });
    const events = result.events!;
    expect(events).toHaveLength(17);
    // USPS's scans keep the minute USPS gave them, without a zone, and the place the wording ends with, without its ZIP code.
    expect(events[0]).toMatchObject({ local_time: '2022-09-07T11:12:00', description: 'Delivered, In/At Mailbox', location: 'CHARLOTTESVILLE VA', stage: 'delivered' });
    expect(events[0]).not.toHaveProperty('time');
    expect(events.find(({ stage }) => stage === 'out_for_delivery'))
      .toMatchObject({ local_time: '2022-09-07T10:47:00', description: 'Out for Delivery', location: 'CHARLOTTESVILLE VA' });
    expect(events.find(({ stage }) => stage === 'registered'))
      .toMatchObject({ local_time: '2022-08-30T16:28:00', description: 'Shipping Label Created, USPS Awaiting Item', location: 'JAMAICA NY' });
    // The line's own rows come to the second on Beijing's clock, without the country ahead of the wording.
    expect(events.find(({ provider_code: code }) => code === 'SHIPMENT'))
      .toMatchObject({ time: '2022-08-30T19:37:10+08:00', description: 'Departed from sorting center', stage: 'in_transit' });
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL'))
      .toMatchObject({ time: '2022-08-30T14:24:12+08:00', description: 'Shipment inbound in sorting center', stage: 'accepted' });
    expect(result).not.toHaveProperty('planned_events');
    expect(JSON.stringify(result)).not.toMatch(/22901|20785|11430|China,/);
  });

  it('cuts the country ahead of the line’s rows and the place after USPS’s', () => {
    expect(splitXsExpressRow('China,Departed from sorting center', 'shenzhen'))
      .toEqual({ content: 'Departed from sorting center', location: 'shenzhen' });
    expect(splitXsExpressRow('Departed USPS Facility HYATTSVILLE MD 20785', 'HYATTSVILLE'))
      .toEqual({ content: 'Departed USPS Facility', location: 'HYATTSVILLE MD 20785' });
    expect(splitXsExpressRow('Departed USPS Regional Destination Facility RICHMOND VA DISTRIBUTION CENTER', 'RICHMOND VA DISTRIBUTION CENTER  '))
      .toEqual({ content: 'Departed USPS Regional Destination Facility', location: 'RICHMOND VA DISTRIBUTION CENTER' });
    // A wording whose place is not at its end keeps both as written.
    expect(splitXsExpressRow('Delivered, In/At Mailbox', 'CHARLOTTESVILLE')).toEqual({ content: 'Delivered, In/At Mailbox', location: 'CHARLOTTESVILLE' });
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseXsExpressTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${XS_EXPRESS_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseXsExpressPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['XS00', `${NUMBER},${UNKNOWN}`]) {
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
    expect(statusMapAnswer({ carrier: 'xs-express', providerCode: 'ARRIVAL', description: 'Shipment inbound in sorting center' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'xs-express', description: 'Delivered, In/At Mailbox' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
