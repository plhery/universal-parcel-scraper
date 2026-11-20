import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureHmmReply } from './browser.js';
import { HMM_LOOKUP, hmmQuery, hmmRequestBody } from './parser.js';

// A synthetic bill, and results naming it with a container that has one move.
const QUERY = hmmQuery('ZZZZ99999999');
const td = (text: string) => `<td><div class="text">${text}</div></td>`;
const REPLY = `<div class="tab-outer" id="trackingInfomationDateResultTable">
<input type="hidden" id="thisBl" value="${QUERY.number}" /><input type="hidden" id="thisCntr" value="ZZZU9999992" />
<table id="containerStatus"><tbody><tr>${['1', 'ZZZU9999992', '', 'DC', 'DC/4H', '1000', QUERY.number, '', 'CY-CY', 'Waybill', '',
  'Export Empty Container Released', '2026-01-01 08:00', ''].map(td).join('')}</tr></tbody></table>
<table id="shipmentProgress"><tbody><tr class="clsMoves">${['2026-01-01', '08:00', 'SYNTHETIC, ZZ', 'Export Empty Container Released', 'Truck'].map(td).join('')}</tr></tbody></table></div>`;
const MISSING = '<div class="tab-outer" id="trackingInfomationDateResultTable"><div class="tab-title">B/L no. is invalid. Please try again with the correct B/L no.</div></div>';
const BODY = hmmRequestBody(QUERY);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface Call { url?: string; method?: string; ownFrame?: boolean; body?: string | null }

function harness() {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame }) as unknown as Page;
  const request = (call: Call = {}) => ({ url: () => call.url ?? HMM_LOOKUP, method: () => call.method ?? 'POST',
    postData: () => call.body === undefined ? BODY : call.body,
    frame: () => call.ownFrame === false ? {} : frame, failure: () => ({ errorText: 'PRIVATE COOKIE in request headers' }) }) as unknown as Request;
  const respond = async (call: Call & { status?: number; headers?: Record<string, string>; read?: () => Promise<Buffer>; text?: string } = {}) => {
    emitter.emit('response', { request: () => request(call), status: () => call.status ?? 200,
      headers: () => ({ 'content-type': 'text/html;charset=UTF-8', ...call.headers }),
      body: call.read ?? (async () => Buffer.from(call.text ?? REPLY)) });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000) => captureHmmReply(page, QUERY, controller.signal, timeout, trigger);
  return { emitter, request, respond, controller, capture };
}

describe('HMM tracking lookup capture', () => {
  it('takes the main frame\'s POST of the lookup for this whole number and its kind, and nothing else', async () => {
    const h = harness();
    const reply = await h.capture(async () => {
      await h.respond({ body: hmmRequestBody(hmmQuery('ZZZZ99999998')), status: 500, text: '' });
      await h.respond({ body: hmmRequestBody({ kind: 'cntr', number: QUERY.number }), status: 500, text: '' });
      await h.respond({ body: JSON.stringify({ ...JSON.parse(BODY), extra: true }), status: 500, text: '' });
      await h.respond({ body: 'srchBlNo1=ZZZZ99999999', status: 500, text: '' });
      await h.respond({ body: null, status: 500, text: '' });
      await h.respond({ url: `${HMM_LOOKUP}?other`, status: 500, text: '' });
      await h.respond({ method: 'GET', status: 500, text: '' });
      await h.respond({ ownFrame: false, status: 500, text: '' });
      await h.respond();
      await h.respond({ status: 500, text: '' });
    });
    expect(reply).toMatchObject({ status: 'pending', last_status_text: 'Export Empty Container Released', last_update: null,
      last_update_local: '2026-01-01T08:00:00' });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('reads Akamai\'s refusal and a rate limit as such, and HMM\'s answer for a number it does not hold as not found', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ status })), String(status)).rejects.toMatchObject({ kind });
    }
    for (const [text, kind] of [[MISSING, 'not_found'], ['<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>', 'schema']] as const) {
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
      .rejects.toMatchObject({ kind: 'transport', message: 'HMM\'s tracking reply could not be read' });
    const h = harness();
    const failed = h.capture(async () => {
      h.emitter.emit('requestfailed', h.request({ url: 'https://www.hmm21.com/other' }));
      h.emitter.emit('requestfailed', h.request());
    });
    await expect(failed).rejects.toMatchObject({ kind: 'transport', message: 'HMM\'s tracking request failed' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    const silent = harness();
    await expect(silent.capture(async () => {}, 20)).rejects.toMatchObject({ kind: 'transport', message: 'HMM\'s page sent no lookup in time' });
    expect(silent.emitter.eventNames()).toEqual([]);
    const cancelled = harness();
    const pending = cancelled.capture(async () => {}, 1000);
    cancelled.controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
