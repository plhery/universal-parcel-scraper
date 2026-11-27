import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { carrierTrackingNumber, formatTrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, IQFULFILLMENT_HISTORY } from './adapter.js';
import { iqfulfillmentReference } from './number.js';
import { normalizeIqFulfillmentNumber, parseIqFulfillment } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' replies; the tests derive invented orders from them.
const DELIVERED = 'IQFAYE002602', CANCELLED = 'AYE0312-1', NOT_DELIVERED = '291460040316';
const INVENTED = 'IQFZZ990000';

type Reply = { success: boolean; tracking_number: string; current_status: string; history: { title: string; description: string; time: number; color: string }[] };
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The delivered sample's reply under the invented reference, changed. */
const changed = (change: (reply: Reply) => void) => {
  const reply = fixture('delivered');
  reply.tracking_number = INVENTED;
  change(reply);
  return reply;
};

describe('IQ Fulfillment references', () => {
  it('takes letters and digits with any hyphen, as the tracker does', () => {
    expect(normalizeIqFulfillmentNumber(` ${DELIVERED.toLowerCase()} `)).toBe(DELIVERED);
    expect(normalizeIqFulfillmentNumber('aye0312 - 1')).toBe(CANCELLED);
    expect(normalizeIqFulfillmentNumber('ECO 0006250557')).toBe('ECO0006250557');
    // A doubled hyphen is one, and a hyphen at either end separates nothing.
    expect(normalizeIqFulfillmentNumber('AYE0312--1')).toBe(CANCELLED);
    expect(normalizeIqFulfillmentNumber('-291460040316-')).toBe(NOT_DELIVERED);
    for (const other of ['', 'ZZ01', 'ABCDEFG', 'AB/12345', 'AB_12345', 'AB-CDEFG', `A${'1'.repeat(40)}`]) {
      expect(() => normalizeIqFulfillmentNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps the hyphen when IQ Fulfillment is the carrier, and only then', () => {
    expect(iqfulfillmentReference(' aye0312 -1 ')).toBe(CANCELLED);
    expect(iqfulfillmentReference(DELIVERED)).toBeUndefined();
    expect(carrierTrackingNumber(' aye0312 -1 ', 'iqfulfillment')).toBe(CANCELLED);
    expect(directTrackingNumber('iqfulfillment', CANCELLED)).toBe(CANCELLED);
    expect(formatTrackingNumber(CANCELLED, 'iqfulfillment')).toBe(CANCELLED);
    expect(carrierTrackingNumber(CANCELLED, 'danx')).toBe(normalizeTrackingNumber(CANCELLED));
    expect(carrierTrackingNumber(CANCELLED, undefined)).toBe('AYE03121');
    // A reference without a hyphen normalizes as before.
    expect(carrierTrackingNumber('eco.0006250557', 'iqfulfillment')).toBe('ECO0006250557');
  });
});

describe('IQ Fulfillment tracking adapter', () => {
  it('asks the tracking service for the whole reference from the tracking page’s origin, as the page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(raw('cancelled')));
    await expect(carrier(fetcher).track({ number: CANCELLED.toLowerCase() })).resolves.toMatchObject({ current_stage: 'exception' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(IQFULFILLMENT_HISTORY);
    expect(JSON.parse(String(init?.body))).toEqual({ tracking_number: CANCELLED });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({
      Origin: 'https://track.iqfulfillment.com', 'X-Domain': 'tracktest.iqfulfillment.com', 'Content-Type': 'application/json', Accept: 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'iqfulfillment', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the service’s own answer for an unknown reference as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(raw('not-found'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, error pages and redirects apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: INVENTED }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const page = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    // The service refuses a request from another origin with HTTP 404 too.
    expect(await answer(() => json(raw('invalid-domain'), { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"success":false,"code":404,"message":"Please enter tracking number."}', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => page('<h1>404 Not Found</h1>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{}', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => page('<title>504 Gateway Time-out</title>', 504))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => page('<title>Just a moment...</title>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => page('<title>Just a moment...</title>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => page('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.iqfulfillment.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{'))).toMatchObject({ kind: 'schema' });
  });
});

describe('IQ Fulfillment replies', () => {
  it('reads the delivered sample: its milestones newest first, at their instants', () => {
    const result = parseIqFulfillment(fixture('delivered'), DELIVERED);
    const event = (time: string, description: string, stage: string) => ({ time, description, stage, stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2025-10-02T06:36:30Z', expected_delivery: null,
      events: [
        event('2025-10-02T06:36:30Z', 'Delivered', 'delivered'),
        event('2025-10-02T05:59:19Z', 'Out for delivery', 'out_for_delivery'),
        event('2025-10-01T05:45:57Z', 'In transit', 'in_transit'),
        event('2025-09-30T11:16:32Z', 'Shipped', 'accepted'),
        event('2025-09-30T06:02:02Z', 'Under process', 'registered'),
        event('2025-09-29T18:18:39Z', 'Order received', 'registered'),
      ],
    });
    // The fixed sentences under the titles, the colours and the picture stay behind.
    expect(JSON.stringify(result)).not.toMatch(/take care|cyan|gif/);
  });

  it('reads a cancelled order and one the delivery partner did not deliver', () => {
    expect(parseIqFulfillment(fixture('cancelled'), CANCELLED)).toMatchObject({
      status: 'exception', current_stage: 'exception', last_status_text: 'Cancelled', last_update: '2025-11-29T07:15:25Z',
      events: [{ description: 'Cancelled', stage: 'exception' }, { description: 'Order received', stage: 'registered' }],
    });
    expect(parseIqFulfillment(fixture('not-delivered'), NOT_DELIVERED)).toMatchObject({
      current_stage: 'failed_attempt', last_status_text: 'Not delivered',
      events: [{ description: 'Not delivered' }, { description: 'In transit' }, { description: 'Shipped' }, { description: 'Order received' }],
    });
  });

  it('keeps the reply’s order for milestones written in the same second', () => {
    const reply = changed((body) => { body.history[4]!.time = body.history[3]!.time; });
    expect(parseIqFulfillment(reply, INVENTED).events!.map((event) => event.description).slice(1, 3)).toEqual(['Out for delivery', 'In transit']);
  });

  it('answers only for the whole reference asked, whatever its case', () => {
    expect(parseIqFulfillment(changed((body) => { body.tracking_number = INVENTED.toLowerCase(); }), INVENTED)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseIqFulfillment(changed(() => undefined), 'IQFZZ990001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The reference without its suffix's hyphen is another order.
    expect(() => parseIqFulfillment(changed((body) => { body.tracking_number = 'AYE03121'; }), CANCELLED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the status the page shows when no milestone came with it, and leaves a new title to the wording rules', () => {
    expect(parseIqFulfillment(changed((body) => { body.history = []; body.current_status = 'Under process'; }), INVENTED))
      .toMatchObject({ current_stage: 'registered', summary_only: true, last_update: null, events: [] });
    const renamed = parseIqFulfillment(changed((body) => { body.current_status = 'Handed over'; body.history[5]!.title = 'Handed over'; }), INVENTED);
    expect(renamed.last_status_text).toBe('Handed over');
    expect(renamed.events!.slice(0, 2).map((event) => event.description)).toEqual(['Handed over', 'Out for delivery']);
    expect(renamed.events![0]!.stage_source).not.toBe('carrier_map');
  });

  it('refuses a changed reply', () => {
    for (const reply of [null, {}, { success: true }, changed((body) => { body.tracking_number = ''; }),
      changed((body) => { (body as { history: unknown }).history = {}; }), changed((body) => { body.history[0]!.title = ''; }),
      changed((body) => { (body.history[0] as { time: unknown }).time = '1759169919'; }), changed((body) => { body.history[0]!.time = 1759169919.5; }),
      changed((body) => { body.history[0]!.time = 86_400; }), changed((body) => { body.history[0]!.title = '<b>Order received</b>'; }),
      changed((body) => { body.history = []; body.current_status = ''; }), { success: false, code: 500, message: 'Server Error' }]) {
      expect(() => parseIqFulfillment(reply, INVENTED), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseIqFulfillment(JSON.parse(raw('not-found')), INVENTED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });
});

describe('IQ Fulfillment statuses', () => {
  it('maps each title the tracker shows', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'iqfulfillment', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'Handed over')).toBeUndefined();
  });
});
