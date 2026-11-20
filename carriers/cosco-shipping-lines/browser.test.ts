import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureCoscoReply } from './browser.js';
import { COSCO_CONTAINERS, COSCO_DETAIL, COSCO_EXISTS, COSCO_REPLY_KEY, type CoscoQuery } from './parser.js';

// A synthetic bill far beyond the ranges in use.
const QUERY: CoscoQuery = { kind: 'bill', number: '9999999990' };
const encode = (value: unknown) => JSON.stringify(Buffer.from(Buffer.from(JSON.stringify(value), 'utf8')
  .map((byte, index) => byte ^ COSCO_REPLY_KEY.charCodeAt(index % COSCO_REPLY_KEY.length))).toString('base64'));
const sizes = { customsSize: 0, fullChainSize: 0, hasCarrierBookingDeclaration: null, mapDisplay: null, shipmentSize: 0, truckSize: 0, warehouseSize: 0 };
const exists = (booking: string) => encode({ code: '200', message: null, success: true,
  result: { ...sizes, bookingNumber: booking, ...(booking ? { fullChainSize: 1, shipmentSize: 1 } : {}) } });
const LOOKUP = encode({ code: '200', message: null, result: { cargoTrackingSummary: { blNumber: QUERY.number } }, success: true });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface Call { url?: string; method?: string; ownFrame?: boolean; body?: unknown }

function harness() {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame }) as unknown as Page;
  const request = (call: Call = {}) => ({ url: () => call.url ?? COSCO_DETAIL, method: () => call.method ?? 'POST',
    frame: () => call.ownFrame === false ? {} : frame,
    postDataJSON: () => 'body' in call ? call.body : { businessNumber: QUERY.number, businessNumberType: 'blNumber', notFilterResult: false },
    failure: () => ({ errorText: 'PRIVATE COOKIE in request headers' }) }) as unknown as Request;
  const respond = async (call: Call & { status?: number; headers?: Record<string, string>; read?: () => Promise<Buffer>; text?: string } = {}) => {
    emitter.emit('response', { request: () => request(call), status: () => call.status ?? 200,
      headers: () => ({ 'content-type': 'application/json', ...call.headers }),
      body: call.read ?? (async () => Buffer.from(call.text ?? LOOKUP)) });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000, query = QUERY) => captureCoscoReply(page, query, controller.signal, timeout, trigger);
  return { emitter, request, respond, controller, capture };
}

describe('COSCO cargo tracking call capture', () => {
  it('takes the main frame\'s lookup for this number after its shipment check, and nothing else', async () => {
    const h = harness();
    const reply = await h.capture(async () => {
      await h.respond({ url: COSCO_EXISTS, text: exists('9999999990') });
      await h.respond({ method: 'OPTIONS', status: 204, text: '' });
      await h.respond({ url: `${COSCO_DETAIL}?x=1`, text: '' });
      await h.respond({ url: COSCO_CONTAINERS, text: '' });
      await h.respond({ ownFrame: false, status: 500, text: '' });
      await h.respond();
    });
    expect(reply).toBe(LOOKUP);
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('reads a container\'s lookup from the containers call', async () => {
    const h = harness();
    const query: CoscoQuery = { kind: 'container', number: 'ZZZU9999992' };
    await expect(h.capture(() => h.respond({ url: COSCO_CONTAINERS, body: { businessNumber: query.number, businessNumberType: 'containerNumber' } }), 1000, query))
      .resolves.toBe(LOOKUP);
  });

  it('answers not found when the page\'s check finds nothing, since the page then looks nothing up', async () => {
    const h = harness();
    await expect(h.capture(() => h.respond({ url: COSCO_EXISTS, text: exists('') }))).rejects.toMatchObject({ kind: 'not_found' });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it.each([
    { businessNumber: '9999999991', businessNumberType: 'blNumber' },
    { businessNumber: QUERY.number, businessNumberType: 'containerNumber' },
    { businessNumber: Number(QUERY.number), businessNumberType: 'blNumber' },
    null,
  ])('fails when the page asks for another number: %j', async body => {
    const h = harness();
    await expect(h.capture(() => h.respond({ body }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads the bot manager\'s refusal and a rate limit as such, not as a missing shipment', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [500, 'indeterminate']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ url: COSCO_EXISTS, status })), String(status)).rejects.toMatchObject({ kind });
    }
  });

  it('refuses an oversized declared reply before reading it and a decoded one after', async () => {
    for (const declared of [true, false]) {
      const h = harness();
      const read = vi.fn(async () => Buffer.alloc(1_000_001));
      await expect(h.capture(() => h.respond({ read, headers: declared ? { 'content-length': '1000001' } : {} }))).rejects.toMatchObject({ kind: 'schema' });
      expect(read).toHaveBeenCalledTimes(declared ? 0 : 1);
    }
  });

  it('keeps browser diagnostics out of read and request failures, and stops waiting at its deadline', async () => {
    const unread = harness();
    await expect(unread.capture(() => unread.respond({ read: async () => { throw new Error('PRIVATE COOKIE in body error'); } })))
      .rejects.toMatchObject({ kind: 'transport', message: 'COSCO\'s tracking reply could not be read' });
    const h = harness();
    const failed = h.capture(async () => {
      h.emitter.emit('requestfailed', h.request({ url: 'https://elines.coscoshipping.com/other' }));
      h.emitter.emit('requestfailed', h.request());
    });
    await expect(failed).rejects.toMatchObject({ kind: 'transport', message: 'COSCO\'s tracking request failed' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    const silent = harness();
    await expect(silent.capture(async () => {}, 20)).rejects.toMatchObject({ kind: 'transport', message: 'COSCO\'s cargo tracking page sent no lookup in time' });
    expect(silent.emitter.eventNames()).toEqual([]);
  });
});
