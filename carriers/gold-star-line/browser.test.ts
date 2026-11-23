import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureGoldStarLineReply } from './browser.js';
import { GOLD_STAR_LINE_LOOKUP, goldStarLineLookupBody, goldStarLineQuery } from './parser.js';

// A synthetic container, and a reply naming it with one activity.
const QUERY = goldStarLineQuery('ZZZU9999992');
const REPLY = { message: 'vgm form successfully submitted', status: 'OK', data: { status: 1, message: { containerid: QUERY.number, response: {
  blRouteLegs: [], consignmentDetails: { type: 'Container', consContainerList: [{ unitPrefix: 'ZZZU', unitNo: '9999992 ', unitActivityList: [{
    activityDateTz: { dateTime: '2026-01-01T08:00:00', offsetMinutes: 540 }, activityDesc: 'Empty container dispatched from inland point to Customer',
    placeFromDesc: 'SYNTHETIC', countryFromName: 'NOWHERE' }] }] } } } } };
const MISSING = { status: 'OK', data: { status: 0, message: { containerid: QUERY.number, response: { statusCode: 'GSL-0016', message: 'reference not found' } } } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface Call { url?: string; method?: string; body?: string | null; ownFrame?: boolean }

function harness() {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame }) as unknown as Page;
  const request = (call: Call = {}) => ({ url: () => call.url ?? GOLD_STAR_LINE_LOOKUP, method: () => call.method ?? 'POST',
    postData: () => call.body === undefined ? goldStarLineLookupBody(QUERY) : call.body,
    frame: () => call.ownFrame === false ? {} : frame, failure: () => ({ errorText: 'PRIVATE COOKIE in request headers' }) }) as unknown as Request;
  const respond = async (call: Call & { status?: number; headers?: Record<string, string>; read?: () => Promise<Buffer>; text?: string } = {}) => {
    emitter.emit('response', { request: () => request(call), status: () => call.status ?? 200,
      headers: () => ({ 'content-type': 'text/html; charset=UTF-8', ...call.headers }),
      body: call.read ?? (async () => Buffer.from(call.text ?? JSON.stringify(REPLY))) });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000) => captureGoldStarLineReply(page, QUERY, controller.signal, timeout, trigger);
  return { emitter, request, respond, controller, capture };
}

describe('Gold Star Line tracking lookup capture', () => {
  it('takes the main frame\'s POST of the lookup for this whole number, and nothing else', async () => {
    const h = harness();
    const reply = await h.capture(async () => {
      await h.respond({ body: '{"action":"header_contents","country_code":"HK"}', status: 500, text: '' });
      for (const number of ['ZZZU9999993', 'ZZZU99999925', 'ZZZU999999']) {
        await h.respond({ body: goldStarLineLookupBody({ kind: 'container', number }), status: 500, text: '' });
      }
      await h.respond({ body: JSON.stringify({ action: 'get_track_shipment_val', containerid: QUERY.number }), status: 500, text: '' });
      await h.respond({ body: 'not json', status: 500, text: '' });
      await h.respond({ body: null, status: 500, text: '' });
      await h.respond({ url: `${GOLD_STAR_LINE_LOOKUP}?containerid=${QUERY.number}`, status: 500, text: '' });
      await h.respond({ url: 'not a url', status: 500, text: '' });
      await h.respond({ method: 'GET', status: 500, text: '' });
      await h.respond({ ownFrame: false, status: 500, text: '' });
      await h.respond();
      await h.respond({ status: 500, text: '' });
    });
    expect(reply).toMatchObject({ status: 'pending', last_status_text: 'Empty container dispatched from inland point to Customer',
      last_update: '2026-01-01T08:00:00+09:00' });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('reads Akamai\'s refusal and a rate limit as such, and Gold Star Line\'s answer for a number it does not hold as not found', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ status })), String(status)).rejects.toMatchObject({ kind });
    }
    for (const [text, kind] of [[JSON.stringify(MISSING), 'not_found'], ['<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>', 'challenge']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ text })), text).rejects.toMatchObject({ kind });
    }
  });

  it('refuses an oversized declared reply before reading it and a larger one after', async () => {
    for (const declared of [true, false]) {
      const h = harness();
      const read = vi.fn(async () => Buffer.alloc(2_000_001));
      await expect(h.capture(() => h.respond({ read, headers: declared ? { 'content-length': '2000001' } : {} }))).rejects.toMatchObject({ kind: 'schema' });
      expect(read).toHaveBeenCalledTimes(declared ? 0 : 1);
    }
  });

  it('keeps browser diagnostics out of read and request failures, and stops waiting at its deadline', async () => {
    const unread = harness();
    await expect(unread.capture(() => unread.respond({ read: async () => { throw new Error('PRIVATE COOKIE in body error'); } })))
      .rejects.toMatchObject({ kind: 'transport', message: 'Gold Star Line\'s tracking reply could not be read' });
    const h = harness();
    const failed = h.capture(async () => {
      h.emitter.emit('requestfailed', h.request({ body: '{"action":"header_contents","country_code":"HK"}' }));
      h.emitter.emit('requestfailed', h.request());
    });
    await expect(failed).rejects.toMatchObject({ kind: 'transport', message: 'Gold Star Line\'s tracking request failed' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    const silent = harness();
    await expect(silent.capture(async () => {}, 20)).rejects.toMatchObject({ kind: 'transport', message: 'Gold Star Line\'s page sent no lookup in time' });
    expect(silent.emitter.eventNames()).toEqual([]);
    const cancelled = harness();
    const pending = cancelled.capture(async () => {}, 1000);
    cancelled.controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
