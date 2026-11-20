import { withHelperContext } from './helper-context.mjs';

export const APM_LOGISTICS_ORIGIN = 'https://apmlogistics.id';
export const APM_LOGISTICS_CAPTURE_BYTES = 256000;
const NUMBER = /^[A-Z0-9]{6,30}$/;
const PROXY = '/api/proxy.php';
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;
// The tracker's answer to a missing token or one reCAPTCHA scores too low.
const REFUSED = 'Google Captcha Error';

export const apmLogisticsPageUrl = number => `${APM_LOGISTICS_ORIGIN}/cek-resi?${new URLSearchParams({ resi: number })}`;
/** The address the page posts every waybill to, with the waybill and its reCAPTCHA token in the form. */
export const apmLogisticsTraceUrl = () => `${APM_LOGISTICS_ORIGIN}${PROXY}?ep=trace`;

export function apmLogisticsBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.pathname === '/cek-resi' && u.searchParams.getAll('resi').length === 1 ? u.searchParams.get('resi') : '';
  return NUMBER.test(number) && url === apmLogisticsPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === apmLogisticsTraceUrl() ? number : null;
}

/** The page's own lookup of this waybill, with the reCAPTCHA token it obtained. */
export function boundApmLogisticsTrace(request, number, page) {
  let u; try { u = new URL(request.url()); } catch { return false; }
  if (request.method() !== 'POST' || u.origin !== APM_LOGISTICS_ORIGIN || u.pathname !== PROXY
    || u.searchParams.getAll('ep').length !== 1 || u.searchParams.get('ep') !== 'trace') return false;
  let form; try { form = new URLSearchParams(request.postData() ?? ''); } catch { return false; }
  return form.getAll('awb').length === 1 && form.get('awb') === number && (!page || request.frame() === page.mainFrame());
}

/** The reply's JSON, which the tracker sends as a JSON string. */
export function apmLogisticsPayload(text) {
  let payload = JSON.parse(text);
  if (typeof payload === 'string') payload = JSON.parse(payload);
  return payload;
}

/** Tracking fields only: names, addresses, phones, rates, staff and couriers stay behind. */
export function projectApmLogisticsReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x, n = 100) => typeof x === 'string' ? x.slice(0, n) : x === null || typeof x === 'number' || typeof x === 'boolean' ? x : null;
  const pick = (x, keys) => record(x) ? Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, text(x[k])])) : null;
  if (!record(payload)) return 'null';
  const out = { success: payload.success === true ? true : payload.success === false ? false : null };
  if (typeof payload.messages === 'string') out.messages = payload.messages.slice(0, 100);
  if (Object.hasOwn(payload, 'shipment')) out.shipment = pick(payload.shipment, ['awb', 'origin_hub', 'dest_hub']);
  for (const side of ['origin', 'destination']) {
    if (Object.hasOwn(payload, side)) out[side] = record(payload[side]) ? { city: text(payload[side]['Kota / Kabupaten']) } : null;
  }
  if (Object.hasOwn(payload, 'checkpoint')) {
    out.checkpoint = Array.isArray(payload.checkpoint) ? payload.checkpoint.slice(0, 301)
      .map(x => pick(x, ['datetime', 'awb_number', 'code_checkpoint', 'origin_citycode', 'origin_branch'])) : null;
  }
  if (Object.hasOwn(payload, 'delivery')) out.delivery = pick(payload.delivery, ['status', 'date', 'time']);
  return JSON.stringify(out);
}

/** The tracker page's own reCAPTCHA and lookup, in a fresh context: one waybill, at most two lookups. */
export async function runApmLogisticsBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = apmLogisticsBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve, trace = apmLogisticsTraceUrl();
  let page, onResponse, accepting = true, expired = false, finish;
  let pageStatus = 0, lookups = 0, runtimeFailed = false;
  const rows = [], pending = new Set();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('APM Logistics browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'apm-logistics-reply' : runtimeFailed ? 'apm-logistics-runtime' : 'apm-logistics-capture_missing' });
  const work = async run => {
    page = run.page;
    let terminal = new Promise(resolve => { finish = resolve; });
    // Only this waybill's lookup goes out; the page's other proxied calls and other waybills do not.
    await page.route(/^https:\/\/apmlogistics\.id\/api\/proxy\.php(?:[/?]|$)/, async route => {
      const request = route.request();
      if (!accepting || expired || !boundApmLogisticsTrace(request, number, page) || ++lookups > 2) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting || !boundApmLogisticsTrace(response.request(), number, page)) return;
      const headers = response.headers();
      const row = { url: trace, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      if (row.status !== 200) { row.body = ''; finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > APM_LOGISTICS_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        if (bytes.length > APM_LOGISTICS_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) { row.error = 'challenge-html'; return; }
        let payload; try { payload = apmLogisticsPayload(text); } catch { row.error = 'invalid-json'; return; }
        // A refused token says so and nothing else.
        if (payload?.success === false && payload.messages === REFUSED) { row.error = 'recaptcha-refused'; row.body = ''; return; }
        row.body = projectApmLogisticsReply(payload);
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left(); if (page.url() !== url) { runtimeFailed = true; return result(); }
    if (pageStatus !== 200) return result();
    await page.bringToFront().catch(() => {}); left();
    // The page reads the waybill from its address, asks reCAPTCHA for a token, then posts both.
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
    return await withHelperContext({ handle, label: 'APM Logistics', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
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
    console.warn(JSON.stringify({ level: 'warn', event: 'apm-logistics.lookup', lookups, status: rows.at(-1)?.status ?? 0,
      reason: result().reason }));
  }
}
