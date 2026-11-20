import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureOoclReply } from './browser.js';
import { OOCL_CAPTCHA_CONFIG, OOCL_REPLY_KEY, OOCL_SUMMARY, OOCL_TRACKER_PAGE, ooclLinkUrl } from './parser.js';

// A synthetic bill far beyond the ranges in use, and synthetic tickets.
const NUMBER = '9999999990';
const TICKET = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const SUMMARY = '"sealed summary"';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function encrypt(value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(OOCL_REPLY_KEY), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))));
  return JSON.stringify(Buffer.concat([iv, sealed]).toString('base64'));
}
const captcha = (shown: boolean) => encrypt({ code: '200', message: null, result: shown, success: true });

interface Call { url?: string; method?: string; ownFrame?: boolean; ticket?: string | null; navigation?: boolean; from?: Request | null }

function harness() {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame }) as unknown as Page;
  const request = (call: Call = {}) => ({ url: () => call.url ?? OOCL_SUMMARY, method: () => call.method ?? 'POST',
    frame: () => call.ownFrame === false ? {} : frame, isNavigationRequest: () => call.navigation ?? false,
    redirectedFrom: () => call.from ?? null, headerValue: async (name: string) => name === 'x-ct-ticket' ? 'ticket' in call ? call.ticket : TICKET : null,
    failure: () => ({ errorText: 'PRIVATE COOKIE in request headers' }) }) as unknown as Request;
  /** The site's link for a number redirecting into the tracker with a ticket. */
  const handOver = (ticket = TICKET, number = NUMBER, call: Call = {}) => {
    const link = request({ url: ooclLinkUrl(number, 'blNumber'), method: 'GET', navigation: true });
    emitter.emit('request', request({ url: `${OOCL_TRACKER_PAGE}?language=en&ticket=${ticket}`, method: 'GET', navigation: true, from: link, ...call }));
  };
  const respond = async (call: Call & { status?: number; headers?: Record<string, string>; read?: () => Promise<Buffer>; text?: string } = {}) => {
    emitter.emit('response', { request: () => request(call), status: () => call.status ?? 200,
      headers: () => ({ 'content-type': 'application/json', ...call.headers }),
      body: call.read ?? (async () => Buffer.from(call.text ?? SUMMARY)) });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000) => captureOoclReply(page, NUMBER, 'blNumber', controller.signal, timeout, trigger);
  return { emitter, request, handOver, respond, controller, capture };
}

describe('OOCL tracker call capture', () => {
  it('takes the main frame\'s summary asked with the ticket the site\'s link handed this number over with, and nothing else', async () => {
    const h = harness();
    const reply = await h.capture(async () => {
      await h.respond();
      h.handOver(OTHER, '9999999991');
      h.handOver(OTHER, NUMBER, { ownFrame: false });
      h.handOver(OTHER, NUMBER, { from: null });
      h.handOver('not a ticket');
      await h.respond({ ticket: OTHER });
      h.handOver();
      await h.respond({ url: OOCL_CAPTCHA_CONFIG, text: await captcha(false) });
      await h.respond({ method: 'OPTIONS', status: 204, text: '' });
      await h.respond({ url: `${OOCL_SUMMARY}?x=1`, text: '' });
      await h.respond({ ownFrame: false, status: 500, text: '' });
      await h.respond({ ticket: OTHER, status: 500, text: '' });
      await h.respond({ ticket: null, status: 500, text: '' });
      await h.respond();
    });
    expect(reply).toBe(SUMMARY);
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('stops when the tracker asks for a CAPTCHA, and when the number is handed over twice', async () => {
    const shown = harness();
    const asked = await captcha(true);
    await expect(shown.capture(async () => { shown.handOver(); await shown.respond({ url: OOCL_CAPTCHA_CONFIG, text: asked }); }))
      .rejects.toMatchObject({ kind: 'challenge', message: 'OOCL\'s tracker asks for a CAPTCHA' });
    const twice = harness();
    await expect(twice.capture(async () => { twice.handOver(); twice.handOver(OTHER); })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads Cloudflare\'s refusal and a rate limit as such, not as a missing shipment', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [500, 'indeterminate']] as const) {
      const h = harness();
      await expect(h.capture(async () => { h.handOver(); await h.respond({ status }); }), String(status)).rejects.toMatchObject({ kind });
      const config = harness();
      await expect(config.capture(() => config.respond({ url: OOCL_CAPTCHA_CONFIG, status })), `config ${status}`).rejects.toMatchObject({ kind });
    }
  });

  it('refuses an oversized declared reply before reading it and a larger one after', async () => {
    for (const declared of [true, false]) {
      const h = harness();
      const read = vi.fn(async () => Buffer.alloc(2_000_001));
      await expect(h.capture(async () => { h.handOver(); await h.respond({ read, headers: declared ? { 'content-length': '2000001' } : {} }); }))
        .rejects.toMatchObject({ kind: 'schema' });
      expect(read).toHaveBeenCalledTimes(declared ? 0 : 1);
    }
  });

  it('keeps browser diagnostics out of read and request failures, and stops waiting at its deadline', async () => {
    const unread = harness();
    await expect(unread.capture(async () => { unread.handOver(); await unread.respond({ read: async () => { throw new Error('PRIVATE COOKIE in body error'); } }); }))
      .rejects.toMatchObject({ kind: 'transport', message: 'OOCL\'s tracking reply could not be read' });
    const h = harness();
    const failed = h.capture(async () => {
      h.emitter.emit('requestfailed', h.request({ url: 'https://pbcontroltower.digital.oocl.com/other' }));
      h.emitter.emit('requestfailed', h.request());
    });
    await expect(failed).rejects.toMatchObject({ kind: 'transport', message: 'OOCL\'s tracking request failed' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    const silent = harness();
    await expect(silent.capture(async () => { silent.handOver(); }, 20)).rejects.toMatchObject({ kind: 'transport', message: 'OOCL\'s tracker sent no lookup in time' });
    expect(silent.emitter.eventNames()).toEqual([]);
    const cancelled = harness();
    const pending = cancelled.capture(async () => {}, 1000);
    cancelled.controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
