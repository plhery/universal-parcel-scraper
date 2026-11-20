import { withHelperContext } from './helper-context.mjs';

export const ROHLIG_SUUS_ORIGIN = 'https://portal.suus.com';
export const ROHLIG_SUUS_CAPTURE_BYTES = 256000;
const NUMBER = /^[A-Z0-9]{6,30}$/;
const ORDERS = '/api/parcel/guest/tracking/orders';
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;
// The one event whose note the page shows as tracking: the planned delivery day.
const NOTED = new Set([327]);
// The tracker's answer when reCAPTCHA scores the page's token too low.
const REFUSED = 'alert_recaptcha_error';

export const rohligSuusPageUrl = number => `${ROHLIG_SUUS_ORIGIN}/order-details/${number}`;
export const rohligSuusOrdersUrl = number => `${ROHLIG_SUUS_ORIGIN}${ORDERS}?${new URLSearchParams({ parcelNumber: number, locale: 'en' })}`;

export function rohligSuusBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = /^\/order-details\/([^/]+)$/.exec(u.pathname)?.[1] ?? '';
  return NUMBER.test(number) && url === rohligSuusPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === rohligSuusOrdersUrl(number) ? number : null;
}

/** The page's own lookup of this number, with the reCAPTCHA token it obtained. */
export function boundRohligSuusOrders(request, number, page) {
  let u; try { u = new URL(request.url()); } catch { return false; }
  return request.method() === 'GET' && u.origin === ROHLIG_SUUS_ORIGIN && u.pathname === ORDERS
    && u.searchParams.getAll('parcelNumber').length === 1 && u.searchParams.get('parcelNumber') === number
    && (!page || request.frame() === page.mainFrame());
}

/** Tracking fields only: addresses, names, references, the principal and the order's documents stay behind. */
export function projectRohligSuusReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const pick = (x, keys) => record(x) ? Object.fromEntries(keys.filter(k => Object.hasOwn(x, k))
    .map(k => [k, ['string', 'number', 'boolean'].includes(typeof x[k]) || x[k] === null ? x[k] : null])) : null;
  if (!record(payload)) return 'null';
  const out = pick(payload, ['parcelNumber', 'statusId', 'stageId', 'location', 'collectDate', 'deliveryDate', 'transportType', 'isAnomaly']);
  for (const side of ['origins', 'destinations']) {
    if (Object.hasOwn(payload, side)) out[side] = Array.isArray(payload[side]) ? payload[side].slice(0, 20).map(x => pick(x, ['country'])) : null;
  }
  if (Object.hasOwn(payload, 'events')) {
    out.events = Array.isArray(payload.events) ? payload.events.slice(0, 301).map(e => record(e) ? {
      ...pick(e, ['statusId', 'created', 'location', 'speedCode']),
      ...(Object.hasOwn(e, 'eventNote') ? { eventNote: NOTED.has(e.statusId) && typeof e.eventNote === 'string' ? e.eventNote.slice(0, 100) : null } : {}),
    } : null) : null;
  }
  return JSON.stringify(out);
}

/** The order page's own reCAPTCHA and lookup, in a fresh context: one number, at most two lookups. */
export async function runRohligSuusBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = rohligSuusBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve, orders = rohligSuusOrdersUrl(number);
  let page, onResponse, accepting = true, expired = false, finish;
  let pageStatus = 0, lookups = 0, runtimeFailed = false;
  const rows = [], pending = new Set();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Rohlig SUUS browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'rohlig-suus-reply' : runtimeFailed ? 'rohlig-suus-runtime' : 'rohlig-suus-capture_missing' });
  const work = async run => {
    page = run.page;
    let terminal = new Promise(resolve => { finish = resolve; });
    // Only this number's lookup goes out; the order's contact box and other numbers do not.
    await page.route(/^https:\/\/portal\.suus\.com\/api\/parcel\/guest\/tracking\/orders(?:[/?]|$)/, async route => {
      const request = route.request();
      if (!accepting || expired || !boundRohligSuusOrders(request, number, page) || ++lookups > 2) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting || !boundRohligSuusOrders(response.request(), number, page)) return;
      const headers = response.headers();
      const row = { url: orders, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      // A known number answers 200 with its order; one the tracker does not know answers 204, a missing token 500,
      // all three empty; a token reCAPTCHA scores too low answers 400 with a message.
      if (row.status === 400) {
        const task = (async () => {
          const bytes = await response.body(); if (!accepting) return;
          let payload; try { payload = JSON.parse(bytes.subarray(0, 2000).toString('utf8')); } catch { /* not the tracker's message */ }
          if (payload?.message === REFUSED) row.error = 'recaptcha-refused';
        })().catch(() => {}).finally(() => { row.body = ''; pending.delete(task); finish(); });
        pending.add(task); return;
      }
      if (row.status !== 200) { row.body = ''; finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > ROHLIG_SUUS_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        if (bytes.length > ROHLIG_SUUS_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) row.error = 'challenge-html';
        else { let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; }
          if (!row.error) row.body = projectRohligSuusReply(payload); }
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left(); if (page.url() !== url) { runtimeFailed = true; return result(); }
    if (pageStatus !== 200) return result();
    await page.bringToFront().catch(() => {}); left();
    // The page asks for its token, then for the order, a few seconds after it loads.
    await terminal;
    if (pending.size) await Promise.all([...pending]);
    // A refused token is the score of that one token: the reloaded page asks for a new one, once.
    if (rows.at(-1)?.error === 'recaptcha-refused' && lookups < 2 && deadline - Date.now() > 10000) {
      terminal = new Promise(resolve => { finish = resolve; });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: left(25000) }); left();
      await terminal;
      if (pending.size) await Promise.all([...pending]);
    }
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    return await withHelperContext({ handle, label: 'Rohlig SUUS', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
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
      } }, work);
  } finally {
    for (const row of rows) if (row.status === 200 && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'rohlig-suus.lookup', lookups, status: rows.at(-1)?.status ?? 0,
      reason: result().reason }));
  }
}
