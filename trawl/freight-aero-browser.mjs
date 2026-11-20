import { withHelperContext } from './helper-context.mjs';
import { recaptchaAudioBackoff } from './recaptcha-backoff.mjs';

/** CHAMP's air cargo tracker, which Biman and other airlines link as their own. */
export const FREIGHT_AERO_PAGE = 'https://www.freight.aero/tracking.asp';
/** The lookup the page posts once its reCAPTCHA calls back. */
export const FREIGHT_AERO_LOOKUP = 'https://www.freight.aero/tracking_service.asp?uuid=&is_portlet=0';
export const FREIGHT_AERO_CAPTURE_BYTES = 512000;
// An air waybill: the airline's three-digit prefix and the eight-digit serial.
const WAYBILL = /^(\d{3})-(\d{8})$/;
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const MAX_ROWS = 10;
const MAX_EVENTS = 500;

/** The address the browser service knows a lookup by: the tracker with the whole waybill after its hash. */
export const freightAeroPageUrl = waybill => `${FREIGHT_AERO_PAGE}#${waybill}`;

export function freightAeroBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const waybill = u.hash.slice(1);
  return WAYBILL.test(waybill) && url === freightAeroPageUrl(waybill) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === FREIGHT_AERO_LOOKUP ? waybill : null;
}

/** The page's own lookup of this one whole waybill, for the airline the page's list gives its prefix. */
export function boundFreightAeroLookup(request, waybill, airline, page) {
  if (request.method() !== 'POST' || request.url() !== FREIGHT_AERO_LOOKUP || (page && request.frame() !== page.mainFrame())) return false;
  let body; try { body = JSON.parse(request.postData() ?? ''); } catch { return false; }
  const rows = body?.awbInfo;
  return !!airline && body?.portalId === 'CHA' && Array.isArray(rows) && rows.length === 1 && rows[0]?.awbNumber === waybill
    && rows[0]?.carrierId === airline && typeof body.captchaResponse === 'string' && body.captchaResponse.length > 0;
}

/** Each waybill's route, status and dated events; weights, flights' dates and the reply's other fields stay behind. */
export function projectFreightAeroReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x, n = 200) => typeof x === 'string' ? x.slice(0, n) : x === null || typeof x === 'number' || typeof x === 'boolean' ? x : null;
  const pick = (x, keys, n) => Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, text(x[k], n)]));
  // A refusal, such as too many lookups, is an object with its reason.
  if (record(payload)) return JSON.stringify(pick(payload, ['error']));
  if (!Array.isArray(payload)) return 'null';
  return JSON.stringify(payload.slice(0, MAX_ROWS + 1).map(row => {
    if (!record(row)) return null;
    const out = pick(row, ['responseCode', 'awbNumber', 'carrier', 'origin', 'destination', 'totalPieces', 'status']);
    if (Object.hasOwn(row, 'events')) {
      const events = record(row.events) ? Object.values(row.events) : row.events;
      out.events = events === null ? null : !Array.isArray(events) ? 'unreadable' : events.slice(0, MAX_EVENTS + 1).map(event => record(event)
        ? pick(event, ['eventSequenceNumber', 'status', 'detail', 'eventTime', 'flightNumber'], 1000) : null);
    }
    return out;
  }));
}

/**
 * The tracker for a whole air waybill in a fresh context. The helper picks the airline its prefix
 * names in the page's own list, enters the serial and asks; the page then shows its reCAPTCHA
 * checkbox and, once that calls back, posts the lookup. Only that lookup reaches the tracker, once.
 */
export async function runFreightAeroBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy,
  solveNativeCaptcha, audioBackoff = recaptchaAudioBackoff }) {
  const waybill = freightAeroBrowserNumber(url, capture); if (!waybill) return undefined;
  signal?.throwIfAborted();
  const [prefix, serial] = waybill.split('-');
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve;
  let page, onResponse, accepting = true, expired = false, airline = '';
  let pageStatus = 0, runtimeFailed = false, unlisted = false, lookups = 0, verification = 'none';
  const rows = [], pending = new Set(), bound = new WeakSet();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('freight.aero browser deadline'); return ms; };
  const reason = () => rows.length ? 'freight-aero-reply' : unlisted ? 'freight-aero-airline_missing'
    : runtimeFailed ? 'freight-aero-runtime' : 'freight-aero-capture_missing';
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows, reason: reason() });
  const work = async run => {
    page = run.page;
    await page.route(/^https:\/\/www\.freight\.aero\/tracking_service\.asp/i, async route => {
      const request = route.request();
      if (!accepting || expired || !boundFreightAeroLookup(request, waybill, airline, page) || ++lookups > 1) return route.abort();
      bound.add(request); return route.fallback();
    });
    onResponse = response => {
      if (!accepting) return;
      const request = response.request();
      if (!bound.has(request)) return;
      const headers = response.headers();
      // The service passes on a submitted number of letters and digits only.
      const row = { url: FREIGHT_AERO_LOOKUP, status: response.status(), trackingNumberSubmitted: waybill.replace('-', ''),
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > FREIGHT_AERO_CAPTURE_BYTES) { row.truncated = true; return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        if (bytes.length > FREIGHT_AERO_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) { row.error = 'challenge-html'; return; }
        // The tracker writes blank lines before its JSON, and an HTML page for a refused token.
        let payload; try { payload = JSON.parse(text); } catch {
          if (row.status === 200) row.error = 'invalid-json'; else row.body = '';
          return;
        }
        row.body = projectFreightAeroReply(payload);
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => pending.delete(task));
      pending.add(task);
    };
    page.on('response', onResponse);
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    if (pageStatus >= 400) return result();
    // The page's list names each airline it tracks by its code and prefix, as "BG-997".
    const options = await page.locator('#carrier_dropdown_1 option').evaluateAll(
      (nodes, wanted) => nodes.map(node => node.value).filter(value => value.length === 6 && value.endsWith(`-${wanted}`)), prefix);
    if (options.length !== 1 || !/^[A-Z0-9]{2}-\d{3}$/.test(options[0])) { unlisted = true; return result(); }
    await page.selectOption('#carrier_dropdown_1', options[0], { timeout: left(5000) });
    airline = options[0].slice(0, 2);
    if (await page.inputValue('#prefix_1', { timeout: left(5000) }) !== prefix) await page.fill('#prefix_1', prefix, { timeout: left(5000) });
    await page.fill('#awb_1', serial, { timeout: left(5000) });
    await page.click('#track-submit', { timeout: left(5000) });
    // The checkbox may pass on its own; the audio solver answers a picture challenge outside its pause.
    if (!solveNativeCaptcha || await audioBackoff.remainingMs() > 0) {
      verification = 'checkbox';
      await page.frameLocator('#captcha_container iframe[src*="recaptcha"][src*="anchor"]').first().locator('#recaptcha-anchor').click({ timeout: left(10000) });
    } else {
      verification = 'audio';
      await solveNativeCaptcha(page, Math.max(1, Math.min(30000, left() - 5000)),
        event => { if (event === 'audio_blocked') void audioBackoff.block(); });
    }
    while (!rows.length) {
      left();
      await page.waitForTimeout(Math.min(250, left()));
    }
    if (pending.size) await Promise.all([...pending]);
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    return await withHelperContext({ handle, label: 'freight.aero', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
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
    console.warn(JSON.stringify({ level: 'warn', event: 'freight-aero.lookup', lookups, verification, page: pageStatus,
      status: rows.at(-1)?.status ?? 0, reason: reason() }));
  }
}
