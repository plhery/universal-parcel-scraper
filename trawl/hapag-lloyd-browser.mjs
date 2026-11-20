import { withHelperContext } from './helper-context.mjs';

/** The guest tracking page, which reads the reference from its address. */
export const HAPAG_PAGE = 'https://www.hapag-lloyd.com/solutions/tracking/';
export const HAPAG_EVENTS = 'https://tracking.api.hlag.cloud/api/tracking/v3/events';
export const HAPAG_CAPTURE_BYTES = 512000;
// A container, a booking or a bill of lading, as the page accepts them.
const REFERENCE = /^(?:[A-Z]{4}\d{7}|\d{1,8}|[A-Z]{4}[A-Z0-9]{12})$/;
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Security Check|Access Denied|Attention Required)/i;
const TURNSTILE = 'https://challenges.cloudflare.com';
const MAX_GROUPS = 200;
const MAX_EVENTS = 300;
const MAX_CLICKS = 3;

export const hapagPageUrl = reference => `${HAPAG_PAGE}#/${reference}`;
/** The containers' moves the page asks for, with the token its Turnstile gave it. */
export const hapagEventsUrl = reference => `${HAPAG_EVENTS}?${new URLSearchParams({ reference })}`;

export function hapagBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const reference = u.hash.startsWith('#/') ? u.hash.slice(2) : '';
  return REFERENCE.test(reference) && url === hapagPageUrl(reference) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === hapagEventsUrl(reference) ? reference : null;
}

/** The page's own lookup of this whole reference. */
export function boundHapagLookup(request, reference, page) {
  return request.method() === 'GET' && request.url() === hapagEventsUrl(reference) && (!page || request.frame() === page.mainFrame());
}

/** Moves, their places and means of transport only: container types, weights and voyages stay behind. */
export function projectHapagReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x, n = 120) => typeof x === 'string' ? x.slice(0, n) : x === null || typeof x === 'number' || typeof x === 'boolean' ? x : null;
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, text(x[k])]));
  if (!record(payload)) return 'null';
  const out = pick(payload, ['errorKey']);
  if (Object.hasOwn(payload, 'groups')) {
    out.groups = !Array.isArray(payload.groups) ? 'unreadable' : payload.groups.slice(0, MAX_GROUPS + 1).map(group => record(group)
      ? { ...pick(group, ['containerNumber']), events: Array.isArray(group.events) ? group.events.slice(0, MAX_EVENTS + 1).map(row => record(row)
        ? pick(row, ['containerNumber', 'eventDescription', 'eventLocation', 'eventDate', 'eventTime', 'eventTransport', 'eventClassifierCode'])
        : null) : 'unreadable' }
      : null);
  }
  return JSON.stringify(out);
}

/**
 * The tracking page for a whole reference in a fresh context. Cloudflare's check and then the
 * page's own Turnstile may each ask for their checkbox; the page then asks for the reference's
 * moves once or twice, and only that lookup reaches the tracking service.
 */
export async function runHapagBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const reference = hapagBrowserNumber(url, capture); if (!reference) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve, events = hapagEventsUrl(reference);
  let page, onResponse, accepting = true, expired = false;
  let pageStatus = 0, runtimeFailed = false, lookups = 0, clicks = 0, lastClick = 0;
  const rows = [], pending = new Set();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Hapag-Lloyd browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'hapag-lloyd-reply' : runtimeFailed ? 'hapag-lloyd-runtime' : 'hapag-lloyd-capture_missing' });
  // One click on a Turnstile checkbox that nothing, such as the cookie banner, covers.
  const clickCheckbox = async () => {
    for (const frame of page.frames()) {
      let origin; try { origin = new URL(frame.url()).origin; } catch { continue; }
      if (origin !== TURNSTILE || frame.parentFrame() !== page.mainFrame()) continue;
      const element = await frame.frameElement().catch(() => null), box = await element?.boundingBox().catch(() => null);
      if (!element || !box || box.width < 295 || box.width > 310 || box.height < 60 || box.height > 100) continue;
      const point = { x: box.x + 22, y: box.y + box.height / 2 };
      const exposed = await element.evaluate((iframe, { x, y }) => {
        const root = iframe.getRootNode(), host = root instanceof ShadowRoot ? root.host : iframe;
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === iframe || hit === host || host.contains(hit));
      }, point).catch(() => false);
      if (!exposed) continue;
      left(); lastClick = Date.now(); clicks++;
      await page.mouse.click(point.x, point.y);
      return;
    }
  };
  const work = async run => {
    page = run.page;
    await page.route(/^https:\/\/tracking\.api\.hlag\.cloud\//, async route => {
      if (!accepting || expired || !boundHapagLookup(route.request(), reference, page) || ++lookups > 2) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting) return;
      const request = response.request();
      // Cloudflare answers the first load with its check, which posts back to the page once it passes.
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && response.url() === HAPAG_PAGE) {
        pageStatus = response.status(); return;
      }
      if (!boundHapagLookup(request, reference, page)) return;
      const headers = response.headers();
      const row = { url: events, status: response.status(), trackingNumberSubmitted: reference,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > HAPAG_CAPTURE_BYTES) { row.truncated = true; return; }
      // A refusal names its reason in an error key, the not-found answer among them.
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        if (bytes.length > HAPAG_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) { row.error = 'challenge-html'; return; }
        let payload; try { payload = JSON.parse(text); } catch {
          if (row.status === 200) row.error = 'invalid-json'; else row.body = '';
          return;
        }
        row.body = projectHapagReply(payload);
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => pending.delete(task));
      pending.add(task);
    };
    page.on('response', onResponse);
    const first = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    if (!pageStatus) pageStatus = first;
    await page.bringToFront().catch(() => {}); left();
    while (!rows.length) {
      left();
      if (clicks < MAX_CLICKS && Date.now() - lastClick >= 5000) await clickCheckbox();
      await page.waitForTimeout(Math.min(250, left()));
    }
    if (pending.size) await Promise.all([...pending]);
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    return await withHelperContext({ handle, label: 'Hapag-Lloyd', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
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
    for (const row of rows) if (row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'hapag-lloyd.lookup', lookups, clicks, page: pageStatus,
      status: rows.at(-1)?.status ?? 0, reason: result().reason }));
  }
}
