export const ONEX_ORIGIN = 'https://onex.am';
export const ONEX_CAPTURE_BYTES = 256000;
const NUMBER = /^[A-Z0-9]{6,40}$/;
const LOOKUP = '/en/onextrack/findtrackingcodeimport';
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;
const IMPORT = ['orderstatus', 'estimateddate', 'estdate', 'estdateto', 'no_estimated_date', 'wo_scanneddate', 'inusadate', 'inmywaydate',
  'inarmeniadate', 'receiveddate'];
const EXPORT = ['orderstatus', 'estimateddate', 'estdate', 'estdateto', 'created_at', 'two_date', 'third_date', 'four_date'];

export const onexPageUrl = number => `${ONEX_ORIGIN}/en/onextrack?${new URLSearchParams({ track: number })}`;
export const onexLookupUrl = () => `${ONEX_ORIGIN}${LOOKUP}`;

export function onexBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.pathname === '/en/onextrack' && u.searchParams.getAll('track').length === 1 ? u.searchParams.get('track') : '';
  return NUMBER.test(number) && url === onexPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === onexLookupUrl() ? number : null;
}

/** The page's own lookup of this number: one form field, the whole number. */
export function boundOnexLookup(request, number, page) {
  if (request.method() !== 'POST' || request.url() !== onexLookupUrl() || (page && request.frame() !== page.mainFrame())) return false;
  const form = new URLSearchParams(request.postData() ?? '');
  return [...form.keys()].length === 1 && form.getAll('tcode').length === 1 && form.get('tcode') === number;
}

/** Tracking fields only: weights, box ids, prices, taxes, couriers' scans and the page's notices stay behind. */
export function projectOnexReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const scalar = x => ['string', 'number', 'boolean'].includes(typeof x) || x === null ? x : null;
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, scalar(x[k])]));
  // An absent record is false or null in the reply; anything else unexpected stays visible as such.
  const side = (x, keys) => x === false || x === null ? x : record(x) ? pick(x, keys) : 'unreadable';
  if (!record(payload)) return 'null';
  const out = pick(payload, ['status']);
  const data = payload.data;
  if (!record(data)) { out.data = null; return JSON.stringify(out); }
  out.data = {
    import: side(data.import, IMPORT),
    export: side(data.export, EXPORT),
    // Another carrier's scans of the inbound parcel: only whether the reply holds them.
    track: data.track === false || data.track === null ? data.track : true,
    iherb: data.iherb === false || data.iherb === null ? data.iherb : Array.isArray(data.iherb)
      ? data.iherb.slice(0, 301).map(e => record(e) ? {
        ...pick(e, ['event_description', 'date', 'location']),
        ...(Object.hasOwn(e, 'pickup_point') ? { pickup_point: record(e.pickup_point) ? pick(e.pickup_point, ['long_name']) : null } : {}),
      } : null) : 'unreadable',
  };
  return JSON.stringify(out);
}

/** The tracking page's own lookup, once Cloudflare lets it load, in a fresh context: one number, at most two lookups. */
export async function runOnexBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = onexBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve, lookup = onexLookupUrl();
  let context, page, timer, abort, onResponse, opening = false, accepting = true, expired = false, finish;
  let pageStatus = 0, lookups = 0, runtimeFailed = false;
  const rows = [], pending = new Set(), closing = new WeakMap();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Onex browser deadline'); return ms; };
  const close = target => {
    if (closing.has(target)) return closing.get(target);
    const task = (async () => { let closed = false, t;
      try { await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { t = setTimeout(resolve, Math.max(1, Math.min(1500, reserve))); })]); }
      finally { clearTimeout(t); if (!closed) handle.requestBrowserReplacement?.('Onex context cleanup failed'); }
    })(); closing.set(target, task); return task;
  };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'onex-reply' : runtimeFailed ? 'onex-runtime' : 'onex-capture_missing' });
  const work = async () => {
    left(); opening = true; const created = await handle.browser.newContext(); opening = false; handle.noteTemporaryContext?.();
    if (expired) { await close(created); throw new Error('Onex context arrived late'); }
    context = created; page = await context.newPage(); left();
    await installPolicy?.(page); left();
    const terminal = new Promise(resolve => { finish = resolve; });
    // Only this number's lookup goes out.
    await page.route(/^https:\/\/onex\.am\/(?:[a-z]{2}\/)?onextrack\/findtrackingcode/, async route => {
      const request = route.request();
      if (!accepting || expired || !boundOnexLookup(request, number, page) || ++lookups > 2) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting || !boundOnexLookup(response.request(), number, page)) return;
      const headers = response.headers();
      const row = { url: lookup, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      if (row.status !== 200) { row.body = ''; finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > ONEX_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        if (bytes.length > ONEX_CAPTURE_BYTES) { row.truncated = true; return; }
        // The tracker labels its JSON as HTML.
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) row.error = 'challenge-html';
        else { let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; }
          if (!row.error) row.body = projectOnexReply(payload); }
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    // Cloudflare may first answer with its challenge page, which reloads the tracker once it passes;
    // the tracker then submits the number from its address.
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left();
    await page.bringToFront().catch(() => {}); left();
    await terminal;
    if (pending.size) await Promise.all([...pending]);
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Onex browser deadline')); }, Math.max(1, deadline - Date.now()));
      abort = () => { expired = true; if (context) void close(context); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([work(), stopped]);
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    if (!pageStatus) runtimeFailed = true;
    return result();
  } finally {
    accepting = false; expired = true; clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort);
    if (page && onResponse) page.off('response', onResponse);
    if (opening) handle.requestBrowserReplacement?.('Onex context arrived after its deadline');
    if (context) await close(context);
    for (const row of rows) if (row.status === 200 && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'onex.lookup', lookups, page: pageStatus, status: rows.at(-1)?.status ?? 0,
      reason: result().reason }));
  }
}
