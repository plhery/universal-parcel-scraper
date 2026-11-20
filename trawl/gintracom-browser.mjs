import { withHelperContext } from './helper-context.mjs';

export const GINTRACOM_ORIGIN = 'https://ec.gintracom.site';
export const GINTRACOM_CAPTURE_BYTES = 256000;
const NUMBER = /^[A-Z0-9]{6,20}$/;
const LOOKUP = '/api/v1/tracking/detalle';
// Statuses whose JSON the helper reads: the reply, an unknown guide, and a refused token.
const READ = [200, 404, 422];
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;
// The tracker's answer to a missing token, or one reCAPTCHA refuses.
const REFUSED = /^Verificaci[oó]n de captcha fallida\.?$/i;
// reCAPTCHA's picture challenge, which the invisible check opens when it doubts the browser.
const PICTURES = 'iframe[src*="/recaptcha/api2/bframe"], iframe[src*="/recaptcha/enterprise/bframe"]';

/** The tracker page for one guide, which looks it up as it loads. */
export const gintracomPageUrl = number => `${GINTRACOM_ORIGIN}/tracking?${new URLSearchParams({ guia: number })}`;
/** The address the page posts a guide to, with the guide and its reCAPTCHA token in a JSON body. */
export const gintracomLookupUrl = () => `${GINTRACOM_ORIGIN}${LOOKUP}`;

export function gintracomBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.pathname === '/tracking' && u.searchParams.getAll('guia').length === 1 ? u.searchParams.get('guia') : '';
  return NUMBER.test(number) && url === gintracomPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === gintracomLookupUrl() ? number : null;
}

/** The page's own lookup of this guide, with the reCAPTCHA token it obtained. */
export function boundGintracomLookup(request, number, page) {
  let u; try { u = new URL(request.url()); } catch { return false; }
  if (request.method() !== 'POST' || u.origin !== GINTRACOM_ORIGIN || u.pathname !== LOOKUP || u.search) return false;
  let body; try { body = JSON.parse(request.postData() ?? ''); } catch { return false; }
  return !!body && typeof body === 'object' && !Array.isArray(body) && body.guia === number
    && Object.keys(body).every(k => k === 'guia' || k === 'recaptcha_token') && (!page || request.frame() === page.mainFrame());
}

/** Tracking fields only: the shop, the contents, the amount to collect, the return risk and the delivery-day choice stay behind. */
export function projectGintracomReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x, n = 200) => typeof x === 'string' ? x.slice(0, n) : x === null || typeof x === 'number' || typeof x === 'boolean' ? x : null;
  const pick = (x, keys) => record(x) ? Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, text(x[k])])) : null;
  if (!record(payload)) return 'null';
  const out = {};
  if (Object.hasOwn(payload, 'message')) out.message = text(payload.message);
  for (const key of ['guia', 'etapa', 'intentos_contacto']) if (Object.hasOwn(payload, key)) out[key] = text(payload[key], 40);
  if (Object.hasOwn(payload, 'estado')) out.estado = pick(payload.estado, ['codigo', 'titulo', 'texto']);
  if (Object.hasOwn(payload, 'fecha_clave')) out.fecha_clave = pick(payload.fecha_clave, ['etiqueta', 'fecha']);
  if (Object.hasOwn(payload, 'historial')) {
    out.historial = Array.isArray(payload.historial) ? payload.historial.slice(0, 301).map(x => pick(x, ['texto', 'fecha', 'tipo'])) : null;
  }
  return JSON.stringify(out);
}

/** The tracker page's own reCAPTCHA and lookup, once Cloudflare lets it load, in a fresh context: one guide, at most two lookups. */
export async function runGintracomBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = gintracomBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve, lookup = gintracomLookupUrl();
  let page, onResponse, accepting = true, expired = false, finish;
  let pageStatus = 0, lookups = 0, runtimeFailed = false, pictures = false;
  const rows = [], pending = new Set();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Gintracom browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'gintracom-reply' : pictures ? 'gintracom-recaptcha-pictures' : runtimeFailed ? 'gintracom-runtime' : 'gintracom-capture_missing' });
  const work = async run => {
    page = run.page;
    let terminal = new Promise(resolve => { finish = resolve; });
    // Only this guide's lookup goes out; the delivery-day choice and other guides do not. The page's
    // reCAPTCHA settings come from another route, which stays open.
    await page.route(/^https:\/\/ec\.gintracom\.site\/api\/v1\/tracking(?:[/?]|$)/, async route => {
      const request = route.request();
      if (!accepting || expired || !boundGintracomLookup(request, number, page) || ++lookups > 2) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting || !boundGintracomLookup(response.request(), number, page)) return;
      const headers = response.headers();
      const row = { url: lookup, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      if (!READ.includes(row.status)) { row.body = ''; finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > GINTRACOM_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        if (bytes.length > GINTRACOM_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) { row.error = 'challenge-html'; return; }
        let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; return; }
        // A refused token says so and nothing else.
        if (row.status === 422 && typeof payload?.message === 'string' && REFUSED.test(payload.message.trim())) {
          row.error = 'recaptcha-refused'; row.body = ''; return;
        }
        row.body = projectGintracomReply(payload);
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    // The invisible check posts nothing while it shows its pictures, which this helper does not answer.
    const watch = async () => {
      while (accepting && !expired) {
        await page.waitForTimeout(Math.min(1000, Math.max(1, deadline - Date.now()))).catch(() => {});
        if (!accepting || expired || rows.length) return;
        if (await page.locator(PICTURES).first().isVisible().catch(() => false)) { pictures = true; finish(); return; }
      }
    };
    // Cloudflare may first answer with its challenge page, which reloads the tracker once it passes;
    // the tracker then reads the guide from its address, asks reCAPTCHA for a token and posts both.
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left();
    await page.bringToFront().catch(() => {}); left();
    void watch();
    await terminal;
    if (pending.size) await Promise.all([...pending]);
    // A refused token is the verdict on that one token: the reloaded page asks for a new one, once.
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
    return await withHelperContext({ handle, label: 'Gintracom', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
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
    for (const row of rows) if (READ.includes(row.status) && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'gintracom.lookup', lookups, page: pageStatus, status: rows.at(-1)?.status ?? 0,
      reason: result().reason }));
  }
}
