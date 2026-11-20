import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureZimReply } from './browser.js';
import { zimLookupUrl, zimQuery } from './parser.js';

// A synthetic bill, and a reply naming it with a container that has one activity.
const QUERY = zimQuery('ZIMUZZZ99999999');
const REPLY = { isSuccess: true, isServerTimeOut: false, consgListItem: [{ referenceNo: QUERY.number, referenceType: 'BL',
  result: { returnCode: '1', returnMessage: 'SUCCESS' }, consDetails: { consContainers: { consContainersItem: [{ unitPrefix: 'ZZZU', unitNo: '9999992',
    unitActivities: { unitActivitiesItem: [{ activityCode: 'OCLE', activityDesc: 'Empty container dispatched from inland point to Customer',
      activityDateTz: '2026-01-01T08:00:00+09:00', placeFromDesc: 'SYNTHETIC', countryFromCode: 'ZZ' }] } }] } } }] };
const URL_ASKED = zimLookupUrl(QUERY);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface Call { url?: string; method?: string; ownFrame?: boolean }

function harness() {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame }) as unknown as Page;
  const request = (call: Call = {}) => ({ url: () => call.url ?? URL_ASKED, method: () => call.method ?? 'GET',
    frame: () => call.ownFrame === false ? {} : frame, failure: () => ({ errorText: 'PRIVATE COOKIE in request headers' }) }) as unknown as Request;
  const respond = async (call: Call & { status?: number; headers?: Record<string, string>; read?: () => Promise<Buffer>; text?: string } = {}) => {
    emitter.emit('response', { request: () => request(call), status: () => call.status ?? 200,
      headers: () => ({ 'content-type': 'application/json; charset=utf-8', ...call.headers }),
      body: call.read ?? (async () => Buffer.from(call.text ?? JSON.stringify(REPLY))) });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000) => captureZimReply(page, QUERY, controller.signal, timeout, trigger);
  return { emitter, request, respond, controller, capture };
}

describe('ZIM tracking lookup capture', () => {
  it('takes the main frame\'s GET of the lookup for this whole number, and nothing else', async () => {
    const h = harness();
    const reply = await h.capture(async () => {
      await h.respond({ url: zimLookupUrl(zimQuery('ZIMUZZZ99999998')), status: 500, text: '' });
      await h.respond({ url: `${URL_ASKED}&reference=ZIMUZZZ99999998`, status: 500, text: '' });
      await h.respond({ url: URL_ASKED.replace('complete-result', 'other'), status: 500, text: '' });
      await h.respond({ url: 'not a url', status: 500, text: '' });
      await h.respond({ method: 'POST', status: 500, text: '' });
      await h.respond({ ownFrame: false, status: 500, text: '' });
      await h.respond();
      await h.respond({ status: 500, text: '' });
    });
    expect(reply).toMatchObject({ status: 'pending', last_status_text: 'Empty container dispatched from inland point to Customer',
      last_update: '2026-01-01T08:00:00+09:00' });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('reads Akamai\'s refusal and a rate limit as such, and ZIM\'s answer for a number it does not hold as not found', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const) {
      const h = harness();
      await expect(h.capture(() => h.respond({ status })), String(status)).rejects.toMatchObject({ kind });
    }
    const missing = { isSuccess: true, consgListItem: [{ referenceNo: QUERY.number, referenceType: 'ER', result: { returnCode: '-1', returnMessage: 'No route legs' } }] };
    for (const [text, kind] of [[JSON.stringify(missing), 'not_found'], ['<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>', 'challenge']] as const) {
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
      .rejects.toMatchObject({ kind: 'transport', message: 'ZIM\'s tracking reply could not be read' });
    const h = harness();
    const failed = h.capture(async () => {
      h.emitter.emit('requestfailed', h.request({ url: 'https://www.zim.com/other' }));
      h.emitter.emit('requestfailed', h.request());
    });
    await expect(failed).rejects.toMatchObject({ kind: 'transport', message: 'ZIM\'s tracking request failed' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    const silent = harness();
    await expect(silent.capture(async () => {}, 20)).rejects.toMatchObject({ kind: 'transport', message: 'ZIM\'s page sent no lookup in time' });
    expect(silent.emitter.eventNames()).toEqual([]);
    const cancelled = harness();
    const pending = cancelled.capture(async () => {}, 1000);
    cancelled.controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
