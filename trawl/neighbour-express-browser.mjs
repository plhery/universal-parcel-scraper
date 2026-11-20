import { withHelperContext } from './helper-context.mjs';

export const NEIGHBOUR_ORIGIN = 'https://neighbourexpress.com';
export const NEIGHBOUR_CAPTURE_BYTES = 500000;
const LOOKUP = '/api/basic/zt/api/website/batchTrackByTrackno';
const RETURN_NUMBER = /^(?:NR[A-Z0-9]{4,38}|N[A-Z0-9]{4}R[A-Z0-9]{1,34})$/;
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;

export const neighbourPageUrl = number => `${NEIGHBOUR_ORIGIN}/track?${new URLSearchParams({ no: number })}`;
export const neighbourLookupUrl = number => `${NEIGHBOUR_ORIGIN}${LOOKUP}?${new URLSearchParams({ tracknos: number })}`;

export function neighbourBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.searchParams.get('no');
  return RETURN_NUMBER.test(number) && url === neighbourPageUrl(number)
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === neighbourLookupUrl(number) ? number : null;
}

/** The native guest POST has one whole query value and no body or account header. */
export function boundNeighbourLookup(request, number, page) {
  return request.method() === 'POST' && request.url() === neighbourLookupUrl(number)
    && !request.postData() && !Object.keys(request.headers()).some(k => k.toLowerCase() === 'authorization')
    && (!page || request.frame() === page.mainFrame());
}

/** Preserve identity, native codes and clocks; omit contacts, notes, keys and rendered pages. */
export function projectNeighbourReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const scalar = (x, max) => typeof x === 'string' ? x.length <= max ? x : null
    : typeof x === 'number' && Number.isFinite(x) || typeof x === 'boolean' || x === null ? x : null;
  if (!record(payload)) return 'null';
  const out = { code: scalar(payload.code, 16), data: null };
  if (payload.data === 0) out.data = 0;
  else if (record(payload.data)) out.data = { results: Array.isArray(payload.data.results)
    ? payload.data.results.slice(0, 3).map(row => record(row) ? {
      trackno: scalar(row.trackno, 64), status: scalar(row.status, 32),
      data: Array.isArray(row.data) ? row.data.slice(0, 301).map(event => record(event) ? {
        status: scalar(event.status, 16), statusText: scalar(event.statusText, 300),
        time: scalar(event.time, 40), timezone: scalar(event.timezone, 32),
      } : null) : null,
    } : null) : null };
  return JSON.stringify(out);
}

/** Let the page obtain its own v3 token and submit once, in a fresh bounded context. */
export async function runNeighbourBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = neighbourBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve, lookup = neighbourLookupUrl(number);
  let page, onResponse, onRequestFailed, forwardedRequest, accepting = true, expired = false, finish;
  let pageStatus = 0, lookups = 0, runtimeFailed = false, networkFailed = false;
  const rows = [], pending = new Set();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Neighbour Express browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: page?.url?.() ?? url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'neighbour-reply' : runtimeFailed ? 'neighbour-runtime'
      : networkFailed ? 'neighbour-network' : 'neighbour-capture_missing' });
  const work = async run => {
    page = run.page;
    const terminal = new Promise(resolve => { finish = resolve; });
    // The postcode/account branches and AJ's unverified fallback cannot send another lookup.
    await page.route(/^https:\/\/neighbourexpress\.com\/api\/basic\/zt\/api\/website\/batchTrackByTrackno/, async route => {
      const request = route.request();
      if (!accepting || expired || !boundNeighbourLookup(request, number, page) || lookups >= 1) return route.abort();
      lookups++;
      forwardedRequest = request;
      return route.fallback();
    });
    onRequestFailed = request => {
      if (accepting && request === forwardedRequest && boundNeighbourLookup(request, number, page)) { networkFailed = true; finish(); }
    };
    onResponse = response => {
      if (!accepting || response.request() !== forwardedRequest || !boundNeighbourLookup(response.request(), number, page)) return;
      const headers = response.headers();
      const row = { url: lookup, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      if (row.status !== 200) { row.body = ''; finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > NEIGHBOUR_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        if (bytes.length > NEIGHBOUR_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) row.error = 'challenge-html';
        else { let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; }
          if (!row.error) row.body = projectNeighbourReply(payload); }
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left();
    await page.bringToFront().catch(() => {}); left();
    await terminal;
    if (pending.size) await Promise.all([...pending]);
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    return await withHelperContext({ handle, label: 'Neighbour Express', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
      openContext: async () => {
        const context = await handle.browser.newContext({ locale: 'en-CA' });
        try { handle.noteTemporaryContext?.(); return context; }
        catch (error) { await context.close().catch(() => {}); throw error; }
      },
      cleanupMs: Math.min(1500, reserve), check: () => left(), closeOnAbort: true, replaceOpening: true,
      onExpire: () => { expired = true; },
      onFailure: () => {
        if (signal?.aborted) signal.throwIfAborted();
        if (!pageStatus) runtimeFailed = true;
        return result();
      },
      onStop: () => {
        accepting = false; expired = true;
        if (page && onResponse) page.off('response', onResponse);
        if (page && onRequestFailed) page.off('requestfailed', onRequestFailed);
      } }, work);
  } finally {
    for (const row of rows) if (row.status === 200 && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'neighbour.lookup', lookups, page: pageStatus, status: rows.at(-1)?.status ?? 0,
      reason: result().reason }));
  }
}
