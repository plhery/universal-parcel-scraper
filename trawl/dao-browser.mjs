export const DAO_API = 'https://dao.as/wp-json/dao-wp/v1/track-parcel';
export const DAO_CAPTURE_BYTES = 256000;
const PAGE = 'https://dao.as/en/track-your-parcel/';
const STATE = 'data-dao-native-state';
export const daoApiUrl = number => `${DAO_API}?${new URLSearchParams({ barcode: number, lang: 'EN' })}`;
export function daoBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = new URLSearchParams(u.hash.slice(1)).get('q');
  return /^(?:00\d{18}|7\d{12}|\d{9})$/.test(number ?? '') && url === `${PAGE}#q=${number}`
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === daoApiUrl(number) ? number : null;
}
export function boundDaoRequest(request, number, page) {
  return request.method() === 'GET' && request.url() === daoApiUrl(number)
    && (!page || request.frame() === page.mainFrame());
}
/** No party fields, cookies, nonces or tokens leave the fresh context. Malformed data stays malformed. */
export function projectDaoReply(payload) {
  const record = x => x && typeof x === 'object' && !Array.isArray(x);
  const pick = (x, keys) => record(x) ? Object.fromEntries(keys.filter(k => Object.hasOwn(x, k))
    .map(k => [k, ['string', 'number', 'boolean'].includes(typeof x[k]) || x[k] === null ? x[k] : null])) : null;
  if (!record(payload) || typeof payload.found !== 'boolean') return 'null';
  const p = payload.parcel;
  const out = { found: payload.found };
  if (Object.hasOwn(payload, 'parcel')) {
    out.parcel = record(p) ? { ...pick(p, ['barcode', 'dist_barcode', 'external_tracking']),
      ...(Object.hasOwn(p, 'pickup') ? { pickup: pick(p.pickup, ['name']) } : {}),
      ...(Object.hasOwn(p, 'events') ? { events: Array.isArray(p.events) ? p.events.map(e => ({ raw: pick(e?.raw,
        ['tidspunkt', 'pakketype', 'haendelse', 'beskrivelse', 'sted']) })) : null } : {}) } : null;
  }
  return JSON.stringify(out);
}
export function installDaoNativeBridge() {
  if (location.origin !== 'https://dao.as' || location.pathname !== '/en/track-your-parcel/') return;
  let ticks = 0;
  const start = () => {
    if (!document.documentElement) { if (++ticks < 200) setTimeout(start, 20); return; }
    const script = document.createElement('script');
    script.textContent = `(${function daoNativeState() {
      const state = { interactive: false, complete: false, code: null };
      window.addEventListener('message', e => {
        if (e.origin !== 'https://challenges.cloudflare.com' || !e.data || typeof e.data !== 'object') return;
        const d = e.data;
        if (d.event === 'interactiveBegin') state.interactive = true;
        if (d.event === 'interactiveEnd' || d.event === 'complete') state.interactive = false;
        if (d.event === 'complete') state.complete = true;
        const code = String(d.code ?? d.errorCode ?? '');
        if (['fail', 'error'].includes(d.event) && /^\d{3,7}$/.test(code)) state.code = code;
        document.documentElement.setAttribute('data-dao-native-state', JSON.stringify(state));
      });
    }.toString()})();`;
    document.documentElement.appendChild(script); script.remove();
  }; start();
}
/** Native Turnstile owns its single-use token and the page's nonce/timing headers. */
export async function runDaoBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = daoBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve;
  let context, page, timer, abort, onResponse, opening = false, accepting = true, expired = false, finish;
  let pageStatus = 0, requests = 0, responses = 0, clicks = 0, lastClick = 0, totalBytes = 0;
  let runtimeFailed = false, nativeCode = null, interactiveSeen = false, completed = false, consentAttempts = 0;
  const rows = [], pending = new Set(), closing = new WeakMap();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('DAO browser deadline'); return ms; };
  const close = target => {
    if (closing.has(target)) return closing.get(target);
    const task = (async () => { let closed = false, t;
      try { await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { t = setTimeout(resolve, Math.max(1, Math.min(1500, reserve))); })]); }
      finally { clearTimeout(t); if (!closed) handle.requestBrowserReplacement?.('DAO context cleanup failed'); }
    })(); closing.set(target, task); return task;
  };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'dao-reply' : runtimeFailed ? 'dao-runtime' : requests ? 'dao-capture_missing'
      : nativeCode ? `dao-verification_${nativeCode}` : 'dao-verification_unfinished' });
  const work = async () => {
    left(); opening = true; const created = await handle.browser.newContext(); opening = false; handle.noteTemporaryContext?.();
    if (expired) { await close(created); throw new Error('DAO context arrived late'); }
    context = created; page = await context.newPage(); left();
    await installPolicy?.(page); left(); await page.addInitScript(installDaoNativeBridge); left();
    const terminal = new Promise(resolve => { finish = resolve; });
    await page.route(/^https:\/\/dao\.as\/wp-json\/dao-wp\/v1\/track-parcel(?:\?|$)/, async route => {
      if (!accepting || expired || !boundDaoRequest(route.request(), number, page) || ++requests > 2) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting || !boundDaoRequest(response.request(), number, page)) return;
      if (++responses > 2) { if (rows.length) rows.at(-1).error = 'response-limit'; finish(); return; }
      const headers = response.headers();
      const row = { url: daoApiUrl(number), status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      if (row.status !== 200) { finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > DAO_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        totalBytes += bytes.length;
        if (bytes.length > DAO_CAPTURE_BYTES || totalBytes > 2 * DAO_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (/_cf_chl_opt|cf-chl-|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(text.slice(0, 64000))) row.error = 'challenge-html';
        else { let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; }
          if (!row.error) row.body = projectDaoReply(payload); }
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
      const reject = page.locator('#declineButton');
      if (consentAttempts < 2 && await reject.isVisible().catch(() => false)) {
        consentAttempts++; await reject.click({ timeout: left(1000) }).catch(() => {});
      }
      let state; try { state = JSON.parse(await page.locator('html').getAttribute(STATE) ?? 'null'); } catch { /* Not ready yet. */ }
      interactiveSeen ||= state?.interactive === true; completed ||= state?.complete === true;
      nativeCode = typeof state?.code === 'string' && /^\d{3,7}$/.test(state.code) ? state.code : null;
      if (nativeCode) break;
      if (state?.interactive === true && !completed && clicks < 3 && Date.now() - lastClick >= 5000) {
        await page.locator('[data-track-turnstile]').scrollIntoViewIfNeeded({ timeout: left(2000) }).catch(() => {});
        for (const frame of page.frames()) {
          let origin; try { origin = new URL(frame.url()).origin; } catch { continue; }
          if (origin !== 'https://challenges.cloudflare.com' || frame.parentFrame() !== page.mainFrame()) continue;
          const element = await frame.frameElement().catch(() => null), box = await element?.boundingBox().catch(() => null);
          if (!box || box.width < 295 || box.width > 310 || box.height < 60 || box.height > 100) continue;
          const point = { x: box.x + 22, y: box.y + box.height / 2 };
          const exposed = await page.evaluate(({ x, y }) => { const root = document.querySelector('[data-track-turnstile]');
            const e = document.elementFromPoint(x, y); return !!root && !!e && root.contains(e); }, point);
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
    const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('DAO browser deadline')); }, Math.max(1, deadline - Date.now()));
      abort = () => { expired = true; if (context) void close(context); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([work(), stopped]);
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    if (!pageStatus) runtimeFailed = true;
    return result();
  } finally {
    accepting = false; expired = true; clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort);
    if (page && onResponse) page.off('response', onResponse);
    if (opening) handle.requestBrowserReplacement?.('DAO context arrived after its deadline');
    if (context) await close(context);
    for (const row of rows) if (row.status === 200 && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'dao.verification', interactive: interactiveSeen, completed, clicks,
      requests, responses, consentAttempts, nativeCode, reason: result().reason }));
  }
}
