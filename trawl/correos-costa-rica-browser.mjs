import { parseHTML } from 'linkedom';
import { recaptchaAudioBackoff } from './recaptcha-backoff.mjs';

export const COSTA_RICA_PAGE = 'https://sucursal.correos.go.cr/web/rastreo';
export const COSTA_RICA_POST = 'https://sucursal.correos.go.cr/web/trackingweb';
const MAX_BODY = 1_000_000;
const MISSING = 'El envío no se encuentra registrado en nuestro sistema';
const clean = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

export function costaRicaBrowserNumber(rawUrl, capture = {}) {
  let url; try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('tracking');
  if (url.origin + url.pathname !== COSTA_RICA_PAGE || url.username || url.password || url.hash
    || [...url.searchParams].length !== 1 || !/^[A-Z0-9]{8,30}$/.test(number ?? '') || !/\d/.test(number)
    || capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== COSTA_RICA_POST) return null;
  return number;
}

/** Selected guest history only; forms, cookies, signer and verification values stay in the context. */
export function costaRicaHistory(html, expected) {
  if (Buffer.byteLength(html) > MAX_BODY) return { kind: 'schema' };
  const { document } = parseHTML(html);
  document.querySelectorAll('script,style,form,input,textarea,iframe,[hidden],[aria-hidden="true"],.d-none,[style*="display:none"],[style*="display: none"]').forEach(e => e.remove());
  const heads = [...document.querySelectorAll('li.d-flex.justify-content-between')].filter(li => clean(li.firstElementChild) === 'Número de envío');
  const rows = [...document.querySelectorAll('tr')].filter(tr => tr.querySelector('td.col-9 h5'));
  if (heads.length > 1 || rows.length > 500) return { kind: 'schema' };
  if (!heads.length) {
    if (!rows.length && clean(document.body).includes(MISSING)) return { kind: 'not_found' };
    return { kind: /captcha|no soy un robot|not a robot/i.test(clean(document.body)) ? 'challenge' : 'unconfirmed' };
  }
  const number = clean(heads[0].lastElementChild);
  if (number !== expected) return { kind: 'identity_mismatch' };
  return { kind: 'history', number, events: rows.map(tr => {
    const cells = tr.querySelectorAll('td.col-9');
    const headings = cells[0]?.querySelectorAll('h5');
    const description = cells[0]?.querySelectorAll('b.upperCase');
    if (cells.length !== 1 || headings.length !== 2 || description.length !== 1) return null;
    const event = { clock: clean(headings[0]), location: clean(headings[1]), description: clean(description[0]) };
    return event.clock.length <= 40 && event.location.length <= 200 && event.description.length <= 1000 ? event : null;
  }) };
}

export function costaRicaPostMatches(request, page, number) {
  if (request.url() !== COSTA_RICA_POST || request.method() !== 'POST' || request.frame() !== page.mainFrame()) return false;
  const form = new URLSearchParams(request.postData() ?? '');
  return form.getAll('tracking').length === 1 && form.get('tracking') === number
    && form.getAll('g-recaptcha-response').length === 1 && !!form.get('g-recaptcha-response')
    && form.getAll('_token').length === 1 && !!form.get('_token');
}

/** Let the official form own its fresh CSRF and reCAPTCHA state and follow its native redirect. */
export async function runCostaRicaBrowser({ url, capture, handle, tier, maxTimeout, installPolicy, signal,
  solveNativeCaptcha, audioBackoff = recaptchaAudioBackoff }) {
  const number = costaRicaBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now(), cleanupMs = Math.min(1500, Math.max(1, Math.floor(maxTimeout / 5)));
  const deadline = start + maxTimeout - cleanupMs, remaining = () => Math.max(1, deadline - Date.now());
  let context, page, timer, responseHandler, expired = false, accepting = true, statusCode = 0, postCount = 0;
  let finish, stop; const terminal = new Promise(resolve => { finish = resolve; });
  const stopped = new Promise((_, reject) => { stop = () => { expired = true; reject(new Error('Costa Rica browser ended')); }; });
  const entries = [], bound = new WeakSet(), pending = new Set();
  const close = async target => {
    let closed = false, cleanupTimer;
    try { await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
      new Promise(resolve => { cleanupTimer = setTimeout(resolve, cleanupMs); })]); }
    finally { clearTimeout(cleanupTimer); if (!closed) handle.requestBrowserReplacement?.('Costa Rica context cleanup failed'); }
  };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 2 || signal?.aborted) throw new Error('No browser budget');
    signal?.addEventListener('abort', stop, { once: true }); timer = setTimeout(stop, remaining());
    return await Promise.race([(async () => {
      const created = await handle.browser.newContext(); handle.noteTemporaryContext?.();
      if (expired) { await close(created); throw new Error('Context arrived late'); } context = created;
      page = await context.newPage(); if (expired) throw new Error('Page arrived late');
      await installPolicy?.(page); if (expired) throw new Error('Policy arrived late');
      await page.route('**/*', async route => {
        const request = route.request(); let address; try { address = new URL(request.url()); } catch { return route.abort(); }
        if (address.origin + address.pathname === COSTA_RICA_POST) {
          if (expired || postCount >= 1 || !costaRicaPostMatches(request, page, number)) return route.abort();
          postCount++; bound.add(request);
        }
        return route.fallback();
      });
      responseHandler = response => {
        if (!accepting) return;
        const request = response.request(); let root = request;
        for (let i = 0; i < 5 && root.redirectedFrom(); i++) root = root.redirectedFrom();
        if (!bound.has(request) && !bound.has(root)) return;
        const headers = response.headers(), address = response.url(), status = response.status();
        const entry = { url: COSTA_RICA_POST, status, trackingNumberSubmitted: number,
          headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0,100)])),
          body: null, truncated: false, base64Encoded: false, error: null };
        if (entries.length >= 5) { entries.at(-1).error = 'capture-limit'; finish(); return; }
        entries.push(entry);
        if (address !== COSTA_RICA_POST && address !== COSTA_RICA_PAGE) { entry.error = 'unexpected-redirect'; finish(); return; }
        if ([301,302,303,307,308].includes(status)) {
          let target; try { target = new URL(headers.location, address).href; } catch { /* Invalid redirect. */ }
          if (address !== COSTA_RICA_POST || target !== COSTA_RICA_PAGE) { entry.error = 'unexpected-redirect'; finish(); }
          return;
        }
        if (status !== 200) { finish(); return; }
        const size = Number(headers['content-length'] ?? 0);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BODY) { entry.truncated = true; finish(); return; }
        const read = response.body().then(bytes => {
          if (!accepting) return;
          if (bytes.length > MAX_BODY) entry.truncated = true;
          else entry.body = JSON.stringify(costaRicaHistory(bytes.toString('utf8'), number));
        }).catch(() => { if (accepting) entry.error = 'body-read'; }).finally(() => { pending.delete(read); finish(); });
        pending.add(read);
      };
      page.on('response', responseHandler);
      statusCode = (await page.goto(COSTA_RICA_PAGE, { waitUntil: 'domcontentloaded', timeout: remaining() }))?.status() ?? 0;
      if (statusCode >= 400 || expired) return result();
      await page.locator('#tracking').fill(number, { timeout: remaining() });
      if (await audioBackoff.remainingMs() > 0 || !solveNativeCaptcha) {
        await page.frameLocator('iframe[src*="recaptcha"][src*="anchor"]').first().locator('#recaptcha-anchor').click({ timeout: Math.min(10000, remaining()) });
        await page.waitForFunction(() => !!document.querySelector('[name="g-recaptcha-response"]')?.value, null, { timeout: Math.min(7000,remaining()) }).catch(() => {});
      } else await solveNativeCaptcha(page, Math.max(1, Math.min(30000, remaining() - 5000)), event => { if (event === 'audio_blocked') audioBackoff.block(); });
      if (expired || !await page.locator('[name="g-recaptcha-response"]').inputValue({ timeout: remaining() }).then(v => !!v, () => false)) return result();
      await page.locator('#btnBuscar').click({ timeout: remaining() });
      await terminal; await Promise.allSettled([...pending]); return result();
    })(), stopped]);
  } catch {
    return statusCode || entries.length ? result() : { tier, status: 'error', durationMs: Date.now() - start, reason: 'Costa Rica browser retrieval failed' };
  } finally {
    accepting = false; expired = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
    if (page && responseHandler) page.off('response', responseHandler);
    if (context) await close(context);
  }
}
