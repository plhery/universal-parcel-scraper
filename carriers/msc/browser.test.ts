import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureMscReply } from './browser.js';
import { MSC_LOOKUP, mscQuery } from './parser.js';

// A synthetic bill, and a reply naming it with a container that has one move.
const QUERY = mscQuery('MEDUZZ999998');
const REPLY = { IsSuccess: true, Data: { TrackingType: 'Bill Of Lading', TrackingNumber: QUERY.number, CurrentDate: '01/01/2026',
  BillOfLadings: [{ BillOfLadingNumber: QUERY.number, ContainersInfo: [{ ContainerNumber: 'ZZZU9999992',
    Events: [{ Order: 0, Date: '01/01/2026', Location: 'SYNTHETIC, ZZ', Description: 'Empty to Shipper', EquipmentHandling: null }] }] }] } };
const BODY = JSON.stringify({ trackingNumber: QUERY.number, trackingMode: '0' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface Call { url?: string; method?: string; ownFrame?: boolean; body?: string | null }

function harness() {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame }) as unknown as Page;
  const request = (call: Call = {}) => ({ url: () => call.url ?? MSC_LOOKUP, method: () => call.method ?? 'POST',
    postData: () => call.body === undefined ? BODY : call.body,
    frame: () => call.ownFrame === false ? {} : frame, failure: () => ({ errorText: 'PRIVATE COOKIE in request headers' }) }) as unknown as Request;
  const respond = async (call: Call & { status?: number; headers?: Record<string, string>; read?: () => Promise<Buffer>; text?: string } = {}) => {
    emitter.emit('response', { request: () => request(call), status: () => call.status ?? 200,
      headers: () => ({ 'content-type': 'application/json', ...call.headers }),
      body: call.read ?? (async () => Buffer.from(call.text ?? JSON.stringify(REPLY))) });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000) => captureMscReply(page, QUERY, controller.signal, timeout, trigger);
  return { emitter, request, respond, controller, capture };
}

describe('MSC tracking lookup capture', () => {
  it('takes the main frame\'s POST of the lookup for this whole number and its mode, and nothing else', async () => {
    const h = harness();
    const reply = await h.capture(async () => {
      await h.respond({ body: JSON.stringify({ trackingNumber: 'MEDUZZ999997', trackingMode: '0' }), status: 500, text: '' });
      await h.respond({ body: JSON.stringify({ trackingNumber: QUERY.number, trackingMode: '1' }), status: 500, text: '' });
      await h.respond({ body: JSON.stringify({ trackingNumber: QUERY.number, trackingMode: '0', extra: true }), status: 500, text: '' });
      await h.respond({ body: 'trackingNumber=MEDUZZ999998', status: 500, text: '' });
      await h.respond({ body: null, status: 500, text: '' });
      await h.respond({ url: `${MSC_LOOKUP}?other`, status: 500, text: '' });
      await h.respond({ method: 'GET', status: 500, text: '' });
      await h.respond({ ownFrame: false, status: 500, text: '' });
      await h.respond();
      await h.respond({ status: 500, text: '' });
    });
    expect(reply).toMatchObject({ status: 'pending', last_status_text: 'Empty to Shipper', last_update_local: '2026-01-01' });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('reads Akamai\'s refusal and a rate limit as such, and MSC\'s answer for a number it does not hold as not found', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ status })), String(status)).rejects.toMatchObject({ kind });
    }
    for (const [text, kind] of [['', 'challenge'], ['<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>', 'challenge'],
      [JSON.stringify({ IsSuccess: false, Data: 'No results found for this Bill of Lading number. Please recheck.' }), 'not_found']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ text })), text).rejects.toMatchObject({ kind });
    }
  });

  it('refuses an oversized declared reply before reading it and a larger one after', async () => {
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
      .rejects.toMatchObject({ kind: 'transport', message: 'MSC\'s tracking reply could not be read' });
    const h = harness();
    const failed = h.capture(async () => {
      h.emitter.emit('requestfailed', h.request({ url: 'https://www.msc.com/other' }));
      h.emitter.emit('requestfailed', h.request());
    });
    await expect(failed).rejects.toMatchObject({ kind: 'transport', message: 'MSC\'s tracking request failed' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    const silent = harness();
    await expect(silent.capture(async () => {}, 20)).rejects.toMatchObject({ kind: 'transport', message: 'MSC\'s page sent no lookup in time' });
    expect(silent.emitter.eventNames()).toEqual([]);
    const cancelled = harness();
    const pending = cancelled.capture(async () => {}, 1000);
    cancelled.controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
