import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureMaerskReply } from './browser.js';
import { MAERSK_API_ORIGIN, maerskLookupUrl, type MaerskQuery } from './parser.js';

// A synthetic bill far beyond the ranges in use.
const QUERY: MaerskQuery = { kind: 'document', number: '999999999' };
const LOOKUP = maerskLookupUrl(QUERY);
const REPLY = { tpdoc_num: QUERY.number, is_container_search: false, containers: [] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface Call { url?: string; method?: string; ownFrame?: boolean }

function harness() {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame }) as unknown as Page;
  const request = (call: Call = {}) => ({ url: () => call.url ?? LOOKUP, method: () => call.method ?? 'GET',
    frame: () => call.ownFrame === false ? {} : frame, failure: () => ({ errorText: 'PRIVATE COOKIE in request headers' }) }) as unknown as Request;
  const respond = async (call: Call & { status?: number; headers?: Record<string, string>; read?: () => Promise<Buffer>; text?: string } = {}) => {
    emitter.emit('response', { request: () => request(call), status: () => call.status ?? 200,
      headers: () => ({ 'content-type': 'application/json', ...call.headers }),
      body: call.read ?? (async () => Buffer.from(call.text ?? JSON.stringify(REPLY))) });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000) => captureMaerskReply(page, QUERY, controller.signal, timeout, trigger);
  return { emitter, request, respond, controller, capture };
}

// Maersk's answer for a number it does not hold, with a synthetic id.
const missing = (number: string) => JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', message: `No tracking data found for: ${number}`,
  method: 'GET', requestUri: `/synergy/tracking/${number}`, status: 404, timestamp: '2026-01-01T00:00:00Z' });

describe('Maersk tracking lookup capture', () => {
  it('takes the main frame\'s GET of the lookup for this whole number and Maersk\'s carrier code, and nothing else', async () => {
    const h = harness();
    const reply = await h.capture(async () => {
      await h.respond({ url: maerskLookupUrl({ kind: 'document', number: '999999998' }), status: 500, text: '' });
      await h.respond({ url: `${MAERSK_API_ORIGIN}/synergy/tracking/${QUERY.number}?operator=SEAU`, status: 500, text: '' });
      await h.respond({ url: `${MAERSK_API_ORIGIN}/synergy/tracking/${QUERY.number}`, status: 500, text: '' });
      await h.respond({ url: `${MAERSK_API_ORIGIN}/synergy/tracking/MAEU${QUERY.number}?operator=MAEU`, status: 500, text: '' });
      await h.respond({ method: 'OPTIONS', status: 204, text: '' });
      await h.respond({ ownFrame: false, status: 500, text: '' });
      await h.respond();
      await h.respond({ status: 500, text: '' });
    });
    expect(reply).toEqual(REPLY);
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('reads Akamai\'s refusal and a rate limit as such, and only the 404 naming the number as not found', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ status })), String(status)).rejects.toMatchObject({ kind });
    }
    for (const [text, kind] of [[missing(QUERY.number), 'not_found'], [missing('999999998'), 'transport'], ['<html>Not Found</html>', 'transport'],
      [missing(QUERY.number).replace('"status":404', '"status":400'), 'transport']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ status: 404, text })), text).rejects.toMatchObject({ kind });
    }
    const page = harness();
    await expect(page.capture(() => page.respond({ text: '<html><body>Access Denied</body></html>' }))).rejects.toMatchObject({ kind: 'schema' });
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
      .rejects.toMatchObject({ kind: 'transport', message: 'Maersk\'s tracking reply could not be read' });
    const h = harness();
    const failed = h.capture(async () => {
      h.emitter.emit('requestfailed', h.request({ url: `${MAERSK_API_ORIGIN}/other` }));
      h.emitter.emit('requestfailed', h.request());
    });
    await expect(failed).rejects.toMatchObject({ kind: 'transport', message: 'Maersk\'s tracking request failed' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    const silent = harness();
    await expect(silent.capture(async () => {}, 20)).rejects.toMatchObject({ kind: 'transport', message: 'Maersk\'s page sent no lookup in time' });
    expect(silent.emitter.eventNames()).toEqual([]);
    const cancelled = harness();
    const pending = cancelled.capture(async () => {}, 1000);
    cancelled.controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
