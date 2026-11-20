import { withHelperContext } from './helper-context.mjs';

export const TURKON_ORIGIN = 'https://myturkonline.turkon.com';
/** The guest tracking page, which takes a number only from its search box. */
export const TURKON_PAGE = `${TURKON_ORIGIN}/tracking`;
export const TURKON_CAPTURE_BYTES = 512000;
const NUMBER = /^[A-Z0-9]{6,20}$/;
const SERVICE = '/shipping-prod-service/tracking/';
// The page asks for the milestones, then for each container's moves, with the guest's empty session.
const LOOKUP = /^\/shipping-prod-service\/tracking\/getTracking(Top|Lower)Information\/(tr|en)\/([^/]+)$/;
const GUEST = JSON.stringify({ token: null, cookie: null });
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Bir dakika|Access Denied|Attention Required)/i;
const MAX_CONTAINERS = 200;
const MAX_EVENTS = 300;

/** The address the adapter names a lookup by; the helper opens the bare page and types the number. */
export const turkonPageUrl = number => `${TURKON_PAGE}?${new URLSearchParams({ tracking: number })}`;
/** The containers' moves for a number, which the adapter reads; the page's language does not change them. */
export const turkonLowerUrl = number => `${TURKON_ORIGIN}${SERVICE}getTrackingLowerInformation/en/${number}`;

export function turkonBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.searchParams.get('tracking') ?? '';
  return NUMBER.test(number) && url === turkonPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === turkonLowerUrl(number) ? number : null;
}

/** The page's own lookup of this whole number, as a guest: `top` or `lower`, else null. */
export function boundTurkonLookup(request, number, page) {
  let u; try { u = new URL(request.url()); } catch { return null; }
  const parts = LOOKUP.exec(u.pathname);
  if (request.method() !== 'POST' || u.origin !== TURKON_ORIGIN || u.search || u.hash || !parts || parts[3] !== number
    || request.postData() !== GUEST || (page && request.frame() !== page.mainFrame())) return null;
  return parts[1] === 'Top' ? 'top' : 'lower';
}

/** Moves and their places only: weights, dangerous goods, reefer settings, vessels, voyages and the empty return depot stay behind. */
export function projectTurkonReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x, n = 120) => typeof x === 'string' ? x.slice(0, n) : x === null || typeof x === 'number' || typeof x === 'boolean' ? x : null;
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, text(x[k])]));
  if (!record(payload)) return 'null';
  const out = pick(payload, ['hasError', 'httpStatus']);
  if (Object.hasOwn(payload, 'errorMessages')) out.errorMessages = Array.isArray(payload.errorMessages) ? payload.errorMessages.length : text(payload.errorMessages);
  out.payload = !Array.isArray(payload.payload) ? 'unreadable' : payload.payload.slice(0, MAX_CONTAINERS + 1).map(item => {
    if (!record(item)) return null;
    const set = item.getKonteynerTakipEventSet;
    const rows = record(set) && Array.isArray(set.results) ? set.results : null;
    return { ...pick(item, ['bookingNo', 'containerNo', 'pol', 'pod', 'polDepartureDate', 'podArrivalDate', 'podEstDate', 'lastEvent', 'lastEventName']),
      events: rows ? rows.slice(0, MAX_EVENTS + 1).map(row => record(row)
        ? pick(row, ['containerNo', 'eventCode', 'eventName', 'eventTarih', 'eventSaat', 'eventLokasyon', 'ekVeri3']) : null) : 'unreadable' };
  });
  return JSON.stringify(out);
}

/**
 * The tracking page, once Cloudflare lets it load, in a fresh context: the number typed into its
 * search box, at most two searches, and the containers' moves it then asks for.
 */
export async function runTurkonBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = turkonBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve, lower = turkonLowerUrl(number);
  let page, onResponse, accepting = true, expired = false, finish;
  let pageStatus = 0, runtimeFailed = false;
  const lookups = { top: 0, lower: 0 }, rows = [], pending = new Set();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Turkon browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'turkon-line-reply' : runtimeFailed ? 'turkon-line-runtime' : 'turkon-line-capture_missing' });
  const work = async run => {
    page = run.page;
    const terminal = new Promise(resolve => { finish = resolve; });
    // Only this number's two lookups go out, each at most twice; the page's other services are left alone.
    await page.route(/^https:\/\/myturkonline\.turkon\.com\/shipping-prod-service\/tracking\//, async route => {
      const request = route.request(), kind = boundTurkonLookup(request, number, page);
      if (!accepting || expired || !kind || ++lookups[kind] > 2) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting) return;
      const request = response.request();
      // Cloudflare answers the first load with its check, which reloads the page once it passes.
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && response.url() === TURKON_PAGE) {
        pageStatus = response.status(); return;
      }
      if (boundTurkonLookup(request, number, page) !== 'lower') return;
      const headers = response.headers();
      const row = { url: lower, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      if (row.status !== 200) { row.body = ''; finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > TURKON_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        if (bytes.length > TURKON_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) { row.error = 'challenge-html'; return; }
        let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; return; }
        row.body = projectTurkonReply(payload);
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    const first = (await page.goto(TURKON_PAGE, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    if (!pageStatus) pageStatus = first;
    left();
    await page.bringToFront().catch(() => {}); left();
    // The search box appears once the check has passed and the page has loaded its tracking module.
    const box = page.locator('input[pinputtext]').first();
    await box.waitFor({ state: 'visible', timeout: left(40000) });
    if (page.url() !== TURKON_PAGE) { runtimeFailed = true; return result(); }
    await box.fill(number, { timeout: left(5000) });
    await box.press('Enter', { timeout: left(5000) });
    await terminal;
    if (pending.size) await Promise.all([...pending]);
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    return await withHelperContext({ handle, label: 'Turkon', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
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
    console.warn(JSON.stringify({ level: 'warn', event: 'turkon-line.lookup', top: lookups.top, lower: lookups.lower, page: pageStatus,
      status: rows.at(-1)?.status ?? 0, reason: result().reason }));
  }
}
