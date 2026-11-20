export const PEDDLER_ORIGIN = 'https://track.pdlr.nl';
export const PEDDLER_CAPTURE_BYTES = 256000;
const NUMBER = /^[A-Z0-9]{6,40}$/;
const FORM = '#trackingForm';
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;

export const peddlerPageUrl = number => `${PEDDLER_ORIGIN}/?${new URLSearchParams({ inquiryNumber: number })}`;
export const peddlerLoaderUrl = number => `${PEDDLER_ORIGIN}/trackntrace/${number}?_data=routes%2Ftrackntrace.%24inquiryNumber`;

export function peddlerBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.searchParams.get('inquiryNumber');
  return NUMBER.test(number ?? '') && url === peddlerPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === peddlerLoaderUrl(number) ? number : null;
}

/** The form's own submit: this number, and a Turnstile response the page obtained. */
export function boundPeddlerAction(request, number, page) {
  let u; try { u = new URL(request.url()); } catch { return false; }
  if (request.method() !== 'POST' || u.origin !== PEDDLER_ORIGIN || u.pathname !== '/' || !u.searchParams.has('index')
    || u.searchParams.get('inquiryNumber') !== number || (page && request.frame() !== page.mainFrame())) return false;
  const form = new URLSearchParams(request.postData() ?? '');
  return form.getAll('inquiryNumber').length === 1 && form.get('inquiryNumber') === number
    && form.getAll('cf-turnstile-response').length === 1 && !!form.get('cf-turnstile-response');
}

export function boundPeddlerLoader(request, number, page) {
  return request.method() === 'GET' && request.url() === peddlerLoaderUrl(number) && (!page || request.frame() === page.mainFrame());
}

/** Tracking fields only: couriers, their positions, the mailbox's address and the page's settings stay behind. */
export function projectPeddlerReply(payload) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const pick = (x, keys) => record(x) ? Object.fromEntries(keys.filter(k => Object.hasOwn(x, k))
    .map(k => [k, ['string', 'number', 'boolean'].includes(typeof x[k]) || x[k] === null ? x[k] : null])) : null;
  if (!record(payload)) return 'null';
  const out = {};
  if (Object.hasOwn(payload, 'error')) out.error = typeof payload.error === 'string' ? payload.error.slice(0, 200) : null;
  if (Object.hasOwn(payload, 'data')) {
    const d = payload.data, p = record(d) ? d.package : undefined;
    out.data = record(d) ? { ...pick(d, ['inquiryNumber']), ...(Object.hasOwn(d, 'carrier') ? { carrier: pick(d.carrier, ['name']) } : {}),
      ...(Object.hasOwn(d, 'package') ? { package: record(p) ? { ...pick(p, ['status', 'trackingNumber', 'estimatedDeliveryDate', 'deliveryDate']),
        ...(Object.hasOwn(p, 'events') ? { events: Array.isArray(p.events) ? p.events.slice(0, 201).map(e => record(e) ? {
          ...pick(e, ['code', 'status', 'ts', 'failedStatus']),
          details: record(e.details) ? { lang: { en: pick(e.details.lang?.en, ['headline', 'description', 'subheading']) } } : null,
          ...(Object.hasOwn(e, 'lang') ? { lang: { en: record(e.lang) && typeof e.lang.en === 'string' ? e.lang.en.slice(0, 500) : null } } : {}),
        } : null) : null } : {}) } : null } : {}) } : null;
  }
  return JSON.stringify(out);
}

/** The page's native Turnstile, its form and its client navigation, in a fresh context; one number, at most two submits. */
export async function runPeddlerBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = peddlerBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve, loader = peddlerLoaderUrl(number);
  let context, page, timer, abort, onResponse, opening = false, accepting = true, expired = false, finish;
  let pageStatus = 0, submits = 0, refused = 0, refusedAt = 0, actionError = false, loads = 0, clicks = 0, lastClick = 0, lastToken = '', totalBytes = 0;
  let runtimeFailed = false;
  const rows = [], pending = new Set(), closing = new WeakMap();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Peddler browser deadline'); return ms; };
  const close = target => {
    if (closing.has(target)) return closing.get(target);
    const task = (async () => { let closed = false, t;
      try { await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { t = setTimeout(resolve, Math.max(1, Math.min(1500, reserve))); })]); }
      finally { clearTimeout(t); if (!closed) handle.requestBrowserReplacement?.('Peddler context cleanup failed'); }
    })(); closing.set(target, task); return task;
  };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'peddler-reply' : runtimeFailed || actionError ? 'peddler-runtime' : refused ? 'peddler-verification_refused'
      : submits ? 'peddler-capture_missing' : 'peddler-verification_unfinished' });
  const work = async () => {
    left(); opening = true; const created = await handle.browser.newContext(); opening = false; handle.noteTemporaryContext?.();
    if (expired) { await close(created); throw new Error('Peddler context arrived late'); }
    context = created; page = await context.newPage(); left();
    await installPolicy?.(page); left();
    const terminal = new Promise(resolve => { finish = resolve; });
    await page.route(/^https:\/\/track\.pdlr\.nl\/(?:\?|trackntrace\/)/, async route => {
      const request = route.request();
      if (request.method() === 'POST') {
        if (!accepting || expired || !boundPeddlerAction(request, number, page) || ++submits > 2) return route.abort();
        return route.fallback();
      }
      if (/[?&]_data=routes%2Ftrackntrace\./.test(request.url())
        && (!accepting || expired || !boundPeddlerLoader(request, number, page) || ++loads > 2)) return route.abort();
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting) return;
      const request = response.request(), headers = response.headers();
      if (boundPeddlerAction(request, number, page)) {
        // A verified submit answers 204 and sends the client to the number's page; a refused token answers 400.
        const redirect = headers['x-remix-redirect'];
        if (response.status() === 400) { refused++; refusedAt = Date.now(); }
        else if (response.status() !== 204 || redirect !== `/trackntrace/${number}`) actionError = true;
        return;
      }
      if (!boundPeddlerLoader(request, number, page)) return;
      const row = { url: loader, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      if (![200, 404].includes(row.status)) { finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > PEDDLER_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body(); if (!accepting) return;
        totalBytes += bytes.length;
        if (bytes.length > PEDDLER_CAPTURE_BYTES || totalBytes > 2 * PEDDLER_CAPTURE_BYTES) { row.truncated = true; return; }
        const text = bytes.toString('utf8');
        if (CHALLENGE.test(text.slice(0, 64000))) row.error = 'challenge-html';
        else { let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; }
          if (!row.error) row.body = projectPeddlerReply(payload); }
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left(); if (page.url() !== url) { runtimeFailed = true; return result(); }
    if (pageStatus !== 200) return result();
    await page.bringToFront().catch(() => {}); left();
    while (accepting && !expired && !rows.length && !actionError && refused < 2) {
      left();
      // A refused token is followed by a fresh one when the page resets its widget.
      if (refused && submits === refused && Date.now() - refusedAt > 10000) break;
      const token = await page.locator(`${FORM} [name="cf-turnstile-response"]`).first().inputValue({ timeout: left(1000) }).catch(() => '');
      if (token && token !== lastToken && submits === refused && submits < 2) {
        lastToken = token;
        // The form's own submit, so its client sends the action and follows the redirect; a banner over the button does not stop it.
        const clicked = await page.locator(`${FORM} button[type="submit"]`).first().click({ timeout: left(3000) }).then(() => true, () => false);
        if (!clicked) await page.evaluate(form => document.querySelector(form)?.requestSubmit(), FORM);
      } else if (!token && Date.now() - start > 5000 && clicks < 3 && Date.now() - lastClick >= 5000) {
        // A managed widget that asks for a click shows its checkbox at the frame's left edge.
        for (const frame of page.frames()) {
          let origin; try { origin = new URL(frame.url()).origin; } catch { continue; }
          if (origin !== 'https://challenges.cloudflare.com' || frame.parentFrame() !== page.mainFrame()) continue;
          const element = await frame.frameElement().catch(() => null), box = await element?.boundingBox().catch(() => null);
          if (!box || box.width < 290 || box.width > 700 || box.height < 60 || box.height > 100) continue;
          const point = { x: box.x + 30, y: box.y + box.height / 2 };
          const exposed = await page.evaluate(({ x, y, form }) => { const root = document.querySelector(form);
            const e = document.elementFromPoint(x, y); return !!root && !!e && root.contains(e); }, { ...point, form: FORM });
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
      timer = setTimeout(() => { expired = true; reject(new Error('Peddler browser deadline')); }, Math.max(1, deadline - Date.now()));
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
    if (opening) handle.requestBrowserReplacement?.('Peddler context arrived after its deadline');
    if (context) await close(context);
    for (const row of rows) if ([200, 404].includes(row.status) && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'peddler.verification', submits, refused, clicks, loads,
      reason: result().reason }));
  }
}
