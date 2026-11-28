import { withHelperContext } from './helper-context.mjs';

// InPost UK's result page runs its own Turnstile and posts the number with the widget's token to
// `/tracking/api`. The helper opens that page for the one number, lets the page do both, clicks the
// widget's checkbox when Turnstile asks for it, and captures the page's one post for that number.
export const INPOST_UK_API = 'https://inpost.co.uk/tracking/api';
export const INPOST_UK_CAPTURE_BYTES = 256000;
const PAGE = 'https://inpost.co.uk/tracking/result';
const CONTAINER = '#tracking-result-turnstile-container';
const STATE = 'data-inpost-uk-native-state';
// Yodel's layouts, the network that became InPost UK, as the adapter's own rule reads them.
const NUMBER = /^(?:J?JD\d{16}|8YDR\d{9}|\d{2}[A-Z]{3}\d{7}A\d{3})$/;
export const inpostUkPageUrl = number => `${PAGE}?parcel_code=${number}`;

export function inpostUkBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.searchParams.get('parcel_code') ?? '';
  return NUMBER.test(number) && url === inpostUkPageUrl(number)
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === INPOST_UK_API ? number : null;
}

/** The page's own post: the whole number and a token, nothing else, from the page itself. */
export function boundInpostUkRequest(request, number, page) {
  if (request.method() !== 'POST' || request.url() !== INPOST_UK_API || (page && request.frame() !== page.mainFrame())) return false;
  let body; try { body = JSON.parse(request.postData() ?? ''); } catch { return false; }
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join() === 'trackingNumber,turnstileToken'
    && body.trackingNumber === number && typeof body.turnstileToken === 'string' && body.turnstileToken.length > 0;
}

/**
 * The reply's status and, per parcel, its number, statuses, destination type and country, delivery
 * window and scans with their code, words, time and town. No names, addresses or tokens leave the
 * context; the parcel's and the first scan's key names do, so a field the projection leaves out shows.
 */
export function projectInpostUkReply(payload) {
  const record = x => x && typeof x === 'object' && !Array.isArray(x);
  const value = x => ['string', 'number', 'boolean'].includes(typeof x) || x === null ? x : null;
  const pick = (x, keys) => record(x) ? Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, value(x[k])])) : null;
  const names = x => record(x) ? Object.keys(x).filter(k => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)).sort().slice(0, 40) : null;
  if (!record(payload) || typeof payload.status !== 'string' || payload.status.length > 40) return 'null';
  const out = { status: payload.status };
  if (Object.hasOwn(payload, 'data')) {
    out.data = Array.isArray(payload.data) ? payload.data.slice(0, 3).map(p => record(p) ? {
      ...pick(p, ['mainTrackingNumber', 'trackingNumber', 'status', 'statusTitle', 'statusDescription']),
      ...(Object.hasOwn(p, 'destination') ? { destination: pick(p.destination, ['locationType', 'countryCode']) } : {}),
      ...(Object.hasOwn(p, 'origin') ? { origin: pick(p.origin, ['countryCode']) } : {}),
      ...(Object.hasOwn(p, 'shipment') ? { shipment: pick(p.shipment, ['type']) } : {}),
      ...(Object.hasOwn(p, 'deliveryTimeWindow') ? { deliveryTimeWindow: pick(p.deliveryTimeWindow, ['startDatetime', 'endDatetime']) } : {}),
      ...(Object.hasOwn(p, 'events') ? { events: Array.isArray(p.events) ? p.events.slice(0, 100).map(e => record(e) ? {
        ...pick(e, ['eventCode', 'eventTitle', 'timestamp', 'status']),
        ...(Object.hasOwn(e, 'location') ? { location: pick(e.location, ['city', 'countryCode']) } : {}),
      } : null) : null } : {}),
      keys: names(p), eventKeys: Array.isArray(p.events) ? names(p.events[0]) : null,
    } : null) : null;
  }
  return JSON.stringify(out);
}

/** Turnstile's own messages to the page: whether it asks for the checkbox, finished, or failed with a code. */
export function installInpostUkNativeBridge() {
  if (location.origin !== 'https://inpost.co.uk' || location.pathname !== '/tracking/result') return;
  let ticks = 0;
  const start = () => {
    if (!document.documentElement) { if (++ticks < 200) setTimeout(start, 20); return; }
    const script = document.createElement('script');
    script.textContent = `(${function inpostUkNativeState() {
      const state = { interactive: false, complete: false, code: null };
      window.addEventListener('message', e => {
        if (e.origin !== 'https://challenges.cloudflare.com' || !e.data || typeof e.data !== 'object') return;
        const d = e.data;
        if (d.event === 'interactiveBegin') state.interactive = true;
        if (d.event === 'interactiveEnd' || d.event === 'complete') state.interactive = false;
        if (d.event === 'complete') state.complete = true;
        const code = String(d.code ?? d.errorCode ?? '');
        if (['fail', 'error'].includes(d.event) && /^\d{3,7}$/.test(code)) state.code = code;
        document.documentElement.setAttribute('data-inpost-uk-native-state', JSON.stringify(state));
      });
    }.toString()})();`;
    document.documentElement.appendChild(script); script.remove();
  }; start();
}

/** The page owns its single-use token; the helper only clicks the checkbox Turnstile shows, at most three times. */
export async function runInpostUkBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = inpostUkBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve;
  let page, onResponse, accepting = true, expired = false, finish;
  let pageStatus = 0, requests = 0, responses = 0, clicks = 0, lastClick = 0, totalBytes = 0;
  let runtimeFailed = false, nativeCode = null, interactiveSeen = false, completed = false, consentAttempts = 0;
  const rows = [], pending = new Set();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('InPost UK browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'inpost-uk-reply' : runtimeFailed ? 'inpost-uk-runtime' : requests ? 'inpost-uk-capture_missing'
      : nativeCode ? `inpost-uk-verification_${nativeCode}` : 'inpost-uk-verification_unfinished' });
  const work = async run => {
    page = run.page;
    await page.addInitScript(installInpostUkNativeBridge); left();
    const terminal = new Promise(resolve => { finish = resolve; });
    await page.route(/^https:\/\/inpost\.co\.uk\/tracking\/api(?:[?#]|$)/, async route => {
      if (!accepting || expired || !boundInpostUkRequest(route.request(), number, page) || ++requests > 2) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting || !boundInpostUkRequest(response.request(), number, page)) return;
      if (++responses > 2) { if (rows.length) rows.at(-1).error = 'response-limit'; finish(); return; }
      const headers = response.headers();
      const row = { url: INPOST_UK_API, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      // A known number answers 200 and an unknown one 404, each with the same JSON; a refused token or an outage keeps its status alone.
      if (row.status !== 200 && row.status !== 404) { finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > INPOST_UK_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        totalBytes += bytes.length;
        if (bytes.length > INPOST_UK_CAPTURE_BYTES || totalBytes > 2 * INPOST_UK_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (/_cf_chl_opt|cf-chl-|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(text.slice(0, 64000))) row.error = 'challenge-html';
        else { let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; }
          if (!row.error) row.body = projectInpostUkReply(payload); }
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left(); if (page.url() !== url) { runtimeFailed = true; return result(); }
    if (pageStatus !== 200) return result();
    await page.bringToFront().catch(() => {}); left();
    while (accepting && !expired && !rows.length) {
      left();
      const decline = page.locator('#CybotCookiebotDialogBodyButtonDecline');
      if (consentAttempts < 2 && await decline.isVisible().catch(() => false)) {
        consentAttempts++; await decline.click({ timeout: left(1000) }).catch(() => {});
      }
      let state; try { state = JSON.parse(await page.locator('html').getAttribute(STATE) ?? 'null'); } catch { /* Not ready yet. */ }
      interactiveSeen ||= state?.interactive === true; completed ||= state?.complete === true;
      nativeCode = typeof state?.code === 'string' && /^\d{3,7}$/.test(state.code) ? state.code : null;
      if (nativeCode) break;
      if (state?.interactive === true && !completed && clicks < 3 && Date.now() - lastClick >= 5000) {
        await page.locator(CONTAINER).scrollIntoViewIfNeeded({ timeout: left(2000) }).catch(() => {});
        for (const frame of page.frames()) {
          let origin; try { origin = new URL(frame.url()).origin; } catch { continue; }
          if (origin !== 'https://challenges.cloudflare.com' || frame.parentFrame() !== page.mainFrame()) continue;
          const element = await frame.frameElement().catch(() => null), box = await element?.boundingBox().catch(() => null);
          if (!box || box.width < 295 || box.width > 310 || box.height < 60 || box.height > 100) continue;
          const point = { x: box.x + 22, y: box.y + box.height / 2 };
          const exposed = await page.evaluate(({ x, y, container }) => { const root = document.querySelector(container);
            const e = document.elementFromPoint(x, y); return !!root && !!e && root.contains(e); }, { ...point, container: CONTAINER });
          if (!exposed) continue;
          left(); lastClick = Date.now(); clicks++; await page.mouse.click(point.x, point.y); break;
        }
      }
      await page.waitForTimeout(Math.min(250, left()));
    }
    if (rows.length && pending.size) await terminal;
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    return await withHelperContext({ handle, label: 'InPost UK', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
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
    for (const row of rows) if ((row.status === 200 || row.status === 404) && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'inpost_uk.verification', interactive: interactiveSeen, completed, clicks,
      requests, responses, consentAttempts, nativeCode, reason: result().reason }));
  }
}
