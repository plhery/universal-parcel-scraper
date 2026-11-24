import { withHelperContext } from './helper-context.mjs';
import { recaptchaAudioBackoff } from './recaptcha-backoff.mjs';

/** The Ministry of Communications' shipment tracker; its form posts to a server action at the page's own address. */
export const KUWAIT_POST_PAGE = 'https://moc.gov.kw/en/shipment-tracking';
const MAX_BODY = 1_000_000;
const MAX_EVENTS = 300;
const S10 = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
// The server action's id, which changes with each deployment of the site; the page sends its own.
const ACTION = /^[0-9a-f]{20,64}$/i;
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected/i;
// The scan fields an adapter reads. The office's local id, the next office, the mail category,
// the item's condition and the signatory and signature stay behind.
const FIELDS = ['COUNTRY', 'COUNTRY_NM', 'EVENT_TYPE_CD', 'EVENT_TYPE_NM', 'DEFAULT_EVENT_TYPE_NM', 'EVENT_LOCAL_DT', 'LOCATION',
  'NON_DELIVERY_REASON_NM', 'NON_DELIVERY_MEASURE_NM', 'RETENTION_REASON_NM'];

/** The address the browser service knows a lookup by: the tracker with the whole item code after its hash. */
export const kuwaitPostPageUrl = number => `${KUWAIT_POST_PAGE}#${number}`;

export function kuwaitPostBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.hash.slice(1);
  return S10.test(number) && url === kuwaitPostPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === KUWAIT_POST_PAGE ? number : null;
}

/** The form's own server action from the main frame: the whole item code once, with one reCAPTCHA token. */
export function kuwaitPostRequestMatches(request, page, number) {
  if (request.method() !== 'POST' || request.frame() !== page.mainFrame()) return false;
  let u; try { u = new URL(request.url()); } catch { return false; }
  u.hash = '';
  if (u.href !== KUWAIT_POST_PAGE || !ACTION.test(request.headers()['next-action'] ?? '')) return false;
  let body; try { body = JSON.parse(request.postData() ?? ''); } catch { return false; }
  const fields = Array.isArray(body) && body.length === 1 && body[0] && typeof body[0] === 'object' && !Array.isArray(body[0]) ? body[0] : null;
  return !!fields && Object.keys(fields).sort().join() === 'captchaToken,trackingId' && fields.trackingId === number
    && typeof fields.captchaToken === 'string' && fields.captchaToken.length > 0;
}

/**
 * The value a server action's reply carries. The reply is React's row format: row 0 names the
 * row that holds the action's value, `{"a":"$@1",…}`, and each row is its id, a colon and JSON.
 */
export function kuwaitPostReplyValue(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const row = /^([0-9a-f]{1,8}):(.*)$/s.exec(line);
    if (!row || rows.has(row[1])) return undefined;
    rows.set(row[1], row[2]);
  }
  let head; try { head = JSON.parse(rows.get('0') ?? ''); } catch { return undefined; }
  const id = typeof head?.a === 'string' ? /^\$@([0-9a-f]{1,8})$/.exec(head.a)?.[1] : undefined;
  if (!id || id === '0' || !rows.has(id)) return undefined;
  try { return JSON.parse(rows.get(id)); } catch { return undefined; }
}

/** The reply's outcome and each scan's kept fields. */
export function projectKuwaitPostReply(value) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  // React writes a string that starts with "$" with a second one, and other values as "$" codes.
  const text = x => typeof x === 'string' ? (x.startsWith('$$') ? x.slice(1, 201) : x.startsWith('$') ? null : x.slice(0, 200))
    : x === null || typeof x === 'number' || typeof x === 'boolean' ? x : null;
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, text(x[k])]));
  if (!record(value)) return null;
  const out = pick(value, ['success', 'message', 'retryAfterSeconds']);
  if (Object.hasOwn(value, 'data')) out.data = !Array.isArray(value.data) ? 'unreadable'
    : value.data.slice(0, MAX_EVENTS + 1).map(row => record(row) ? pick(row, FIELDS) : null);
  return JSON.stringify(out);
}

/**
 * The tracker for one whole item code in a fresh context. The helper enters the code, ticks the
 * reCAPTCHA checkbox, or answers its audio challenge outside the audio pause, and sends the
 * form. Only the form's server action for that code reaches the tracker, once.
 */
export async function runKuwaitPostBrowser({ url, capture, handle, tier, maxTimeout, installPolicy, signal,
  solveNativeCaptcha, audioBackoff = recaptchaAudioBackoff }) {
  const number = kuwaitPostBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now(), cleanupMs = Math.min(1500, Math.max(1, Math.floor(maxTimeout / 5)));
  const deadline = start + maxTimeout - cleanupMs, remaining = () => Math.max(1, deadline - Date.now());
  let page, responseHandler, expired = false, accepting = true, statusCode = 0, sent = 0, verification = 'none';
  let finish; const terminal = new Promise(resolve => { finish = resolve; });
  const entries = [], bound = new WeakSet(), pending = new Set();
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  const failed = () => statusCode || entries.length ? result()
    : { tier, status: 'error', durationMs: Date.now() - start, reason: 'Kuwait Post browser retrieval failed' };
  if (!Number.isFinite(maxTimeout) || maxTimeout < 2 || signal?.aborted) return failed();
  try {
    return await withHelperContext({ handle, label: 'Kuwait Post', timeoutMs: remaining(), signal, installPolicy, cleanupMs,
      closeOnAbort: true, onExpire: () => { expired = true; }, onFailure: failed,
      onStop: () => {
        accepting = false; expired = true;
        if (page && responseHandler) page.off('response', responseHandler);
      } }, async run => {
      page = run.page;
      await page.route(/^https:\/\/moc\.gov\.kw\/en\/shipment-tracking(?:[?#]|$)/, async route => {
        const request = route.request();
        if (request.method() === 'POST') {
          if (expired || sent >= 1 || !kuwaitPostRequestMatches(request, page, number)) return route.abort();
          sent++; bound.add(request);
        }
        return route.fallback();
      });
      responseHandler = response => {
        if (!accepting) return;
        const request = response.request();
        if (!bound.has(request)) return;
        const headers = response.headers(), status = response.status();
        // The reply does not repeat the code: the bound request is the evidence.
        const entry = { url: KUWAIT_POST_PAGE, status, trackingNumberSubmitted: number,
          headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
          body: null, truncated: false, base64Encoded: false, error: null };
        entries.push(entry);
        if ([301, 302, 303, 307, 308].includes(status)) { entry.error = 'unexpected-redirect'; finish(); return; }
        if (status !== 200) { finish(); return; }
        const size = Number(headers['content-length'] ?? 0);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BODY) { entry.truncated = true; finish(); return; }
        const read = response.body().then(bytes => {
          if (!accepting) return;
          if (bytes.length > MAX_BODY) { entry.truncated = true; return; }
          const text = bytes.toString('utf8');
          if (CHALLENGE.test(text.slice(0, 64000))) { entry.error = 'challenge-html'; return; }
          const projected = projectKuwaitPostReply(kuwaitPostReplyValue(text));
          if (projected === null) entry.error = 'invalid-reply'; else entry.body = projected;
        }).catch(() => { if (accepting) entry.error = 'body-read'; }).finally(() => { pending.delete(read); finish(); });
        pending.add(read);
      };
      page.on('response', responseHandler);
      statusCode = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() }))?.status() ?? 0;
      if (statusCode >= 400 || expired) return result();
      // The checkbox appears once the page has hydrated, after which the form keeps what is typed.
      const anchor = 'iframe[src*="recaptcha"][src*="anchor"]';
      await page.locator(anchor).first().waitFor({ state: 'attached', timeout: Math.min(20000, remaining()) });
      await page.locator('#tracking_id').fill(number, { timeout: remaining() });
      // The checkbox passes without a picture from a home network; the audio solver is the fallback, within its pause.
      if (await audioBackoff.remainingMs() > 0 || !solveNativeCaptcha) {
        verification = 'checkbox';
        await page.frameLocator(anchor).first().locator('#recaptcha-anchor').click({ timeout: Math.min(10000, remaining()) });
        await page.waitForFunction(() => !!document.querySelector('[name="g-recaptcha-response"]')?.value, null,
          { timeout: Math.min(7000, remaining()) }).catch(() => {});
      } else {
        verification = 'audio';
        await solveNativeCaptcha(page, Math.max(1, Math.min(30000, remaining() - 5000)), event => { if (event === 'audio_blocked') void audioBackoff.block(); });
      }
      if (expired || !await page.locator('[name="g-recaptcha-response"]').first().inputValue({ timeout: remaining() }).then(v => !!v, () => false)) return result();
      await page.locator('form button[type="submit"]').click({ timeout: remaining() });
      await terminal; await Promise.allSettled([...pending]); return result();
    });
  } finally {
    for (const entry of entries) if (entry.status === 200 && entry.body === null && !entry.error && !entry.truncated) entry.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'kuwait-post.lookup', lookups: sent, verification, page: statusCode,
      status: entries.at(-1)?.status ?? 0 }));
  }
}
