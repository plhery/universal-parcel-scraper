import { withHelperContext } from './helper-context.mjs';
import { parseHTML } from 'linkedom';
import { recaptchaAudioBackoff } from './recaptcha-backoff.mjs';
import { RECAPTCHA_ANCHOR, solveRecaptchaImages } from './recaptcha-image.mjs';

export const PASAREX_PAGE = 'https://tracking.pasarex.com/';
export const PASAREX_RESULT = 'https://tracking.pasarex.com/tracking';
const MAX_BODY = 1_000_000;
// The tracker's only notice, the same for a number it does not hold and for a refused checkbox token.
const MISSING = 'Guía no encontrada';
const COLUMNS = 'Description|City|Date|Hour';
const clean = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
// The picture solver's outcome and counts, with no number, picture or token.
const reportPictures = fields => console.warn(JSON.stringify({ level: 'warn', event: 'pasarex.recaptcha_images', ...fields }));

export function pasarexBrowserNumber(rawUrl, capture = {}) {
  let url; try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('awb');
  if (url.origin + url.pathname !== PASAREX_PAGE || url.username || url.password || url.hash
    || [...url.searchParams].length !== 1 || !/^[A-Z0-9]{6,30}$/.test(number ?? '') || !/\d/.test(number)
    || capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== PASAREX_RESULT) return null;
  return number;
}

/** The order's number and its timeline, grouped under the tracker's statuses; the form and its token stay in the context. */
export function pasarexHistory(html, expected) {
  if (Buffer.byteLength(html) > MAX_BODY) return { kind: 'schema' };
  const { document } = parseHTML(html);
  document.querySelectorAll('script,style,form,input,textarea,iframe,[hidden],[aria-hidden="true"],.d-none,[style*="display:none"],[style*="display: none"]').forEach(e => e.remove());
  const heads = [...document.querySelectorAll('p')].map(p => /^AWB Number ([A-Z0-9-]{1,40})$/.exec(clean(p))).filter(Boolean);
  const timeline = document.querySelectorAll('.timeline');
  if (heads.length > 1 || timeline.length > 1) return { kind: 'schema' };
  if (!heads.length) {
    if (!timeline.length && clean(document.body).includes(MISSING)) return { kind: 'not_found' };
    return { kind: /captcha|no soy un robot|not a robot/i.test(clean(document.body)) ? 'challenge' : 'unconfirmed' };
  }
  if (heads[0][1] !== expected) return { kind: 'identity_mismatch' };
  if (!timeline.length) return { kind: 'unconfirmed' };
  const groups = [...timeline[0].children].filter(node => node.tagName === 'DIV');
  if (groups.length > 50) return { kind: 'schema' };
  let count = 0;
  const read = groups.map(group => {
    const status = clean(group.querySelector('.d-flex p'));
    const columns = [...group.querySelectorAll('thead th')].map(clean).join('|');
    const rows = [...group.querySelectorAll('tbody tr')];
    count += rows.length;
    if (!status || status.length > 100 || columns !== COLUMNS) return null;
    return { status, rows: rows.map(tr => {
      const cells = [...tr.querySelectorAll('td')].map(clean);
      if (cells.length !== 4) return null;
      const [description, city, date, hour] = cells;
      return description.length <= 1000 && city.length <= 200 && date.length <= 20 && hour.length <= 20 ? { description, city, date, hour } : null;
    }) };
  });
  if (count > 500) return { kind: 'schema' };
  return { kind: 'history', number: heads[0][1], groups: read };
}

/** The form's own GET, from the main frame, with the whole number once and one token. */
export function pasarexRequestMatches(request, page, number) {
  if (request.method() !== 'GET' || request.frame() !== page.mainFrame()) return false;
  let url; try { url = new URL(request.url()); } catch { return false; }
  if (url.origin + url.pathname !== PASAREX_RESULT) return false;
  const keys = [...url.searchParams.keys()];
  return keys.every(key => ['awb', 'old_awb', 'g-recaptcha-response'].includes(key))
    && url.searchParams.getAll('awb').length === 1 && url.searchParams.get('awb') === number
    && url.searchParams.getAll('old_awb').length <= 1 && (url.searchParams.get('old_awb') ?? number) === number
    && url.searchParams.getAll('g-recaptcha-response').length === 1 && !!url.searchParams.get('g-recaptcha-response');
}

/** Tick the official form's checkbox, send its GET and read the page it returns, bound to the whole number. */
export async function runPasarexBrowser({ url, capture, handle, tier, maxTimeout, installPolicy, signal,
  solveNativeCaptcha, audioBackoff = recaptchaAudioBackoff, solveImages = solveRecaptchaImages, reportImages = reportPictures }) {
  const number = pasarexBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now(), cleanupMs = Math.min(1500, Math.max(1, Math.floor(maxTimeout / 5)));
  const deadline = start + maxTimeout - cleanupMs, remaining = () => Math.max(1, deadline - Date.now());
  let page, responseHandler, expired = false, accepting = true, statusCode = 0, sent = 0;
  let finish; const terminal = new Promise(resolve => { finish = resolve; });
  const entries = [], bound = new WeakSet(), pending = new Set();
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  const failed = () => statusCode || entries.length ? result() : { tier, status: 'error', durationMs: Date.now() - start, reason: 'PasarEX browser retrieval failed' };
  if (!Number.isFinite(maxTimeout) || maxTimeout < 2 || signal?.aborted) return failed();
  return withHelperContext({ handle, label: 'PasarEX', timeoutMs: remaining(), signal, installPolicy, cleanupMs,
    onExpire: () => { expired = true; }, onFailure: failed,
    onStop: () => {
      accepting = false; expired = true;
      if (page && responseHandler) page.off('response', responseHandler);
    } }, async run => {
    page = run.page;
    await page.route('**/*', async route => {
      const request = route.request(); let address; try { address = new URL(request.url()); } catch { return route.abort(); }
      if (address.origin + address.pathname === PASAREX_RESULT) {
        if (expired || sent >= 1 || !pasarexRequestMatches(request, page, number)) return route.abort();
        sent++; bound.add(request);
      }
      return route.fallback();
    });
    responseHandler = response => {
      if (!accepting) return;
      const request = response.request();
      if (!bound.has(request)) return;
      const headers = response.headers(), status = response.status();
      const entry = { url: PASAREX_RESULT, status, trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, truncated: false, base64Encoded: false, error: null };
      if (entries.length >= 5) { entries.at(-1).error = 'capture-limit'; finish(); return; }
      entries.push(entry);
      if ([301, 302, 303, 307, 308].includes(status)) { entry.error = 'unexpected-redirect'; finish(); return; }
      if (status !== 200) { finish(); return; }
      const size = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BODY) { entry.truncated = true; finish(); return; }
      const read = response.body().then(bytes => {
        if (!accepting) return;
        if (bytes.length > MAX_BODY) entry.truncated = true;
        else entry.body = JSON.stringify(pasarexHistory(bytes.toString('utf8'), number));
      }).catch(() => { if (accepting) entry.error = 'body-read'; }).finally(() => { pending.delete(read); finish(); });
      pending.add(read);
    };
    page.on('response', responseHandler);
    statusCode = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() }))?.status() ?? 0;
    if (statusCode >= 400 || expired) return result();
    await page.locator('#awb').fill(number, { timeout: remaining() });
    // The checkbox passes without a picture from a home network. The pictures it asks for elsewhere go to the local
    // detector; the audio solver comes last, within its pause, since audio from a refused address only adds to the block.
    const token = () => page.locator('[name="g-recaptcha-response"]').inputValue({ timeout: remaining() }).then(v => !!v, () => false);
    await page.frameLocator(RECAPTCHA_ANCHOR).first().locator('#recaptcha-anchor').click({ timeout: Math.min(10000, remaining()) });
    if (await solveImages(page, { timeoutMs: Math.max(1, Math.min(35000, remaining() - 5000)), signal, report: reportImages }))
      await page.waitForFunction(() => !!document.querySelector('[name="g-recaptcha-response"]')?.value, null, { timeout: Math.min(3000, remaining()) }).catch(() => {});
    if (!expired && solveNativeCaptcha && remaining() > 15000 && !await token() && await audioBackoff.remainingMs() <= 0)
      await solveNativeCaptcha(page, Math.max(1, Math.min(30000, remaining() - 5000)), event => { if (event === 'audio_blocked') audioBackoff.block(); });
    if (expired || !await token()) return result();
    // The token is a few seconds old when the form sends it, well within its two minutes.
    await page.locator('form button[type="submit"]').click({ timeout: remaining() });
    await terminal; await Promise.allSettled([...pending]); return result();
  });
}
