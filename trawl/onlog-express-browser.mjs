import { withHelperContext } from './helper-context.mjs';

const PORTAL = 'https://onlog.app.br';
const PAGE = 'https://conecta.log.br/rastreio.php';
export const ONLOG_EXPRESS_API = 'https://conecta.log.br/view/jsRastreio.php';
export const ONLOG_EXPRESS_CAPTURE_BYTES = 512 * 1024;
const ATTRIBUTE = 'data-onlog-guest-state';

export function onlogExpressBrowserNumber(raw, capture = {}) {
  let u; try { u = new URL(raw); } catch { return null; }
  const match = /^\/rastreio\/(AA\d{10})$/.exec(u.pathname);
  return u.origin === PORTAL && !u.username && !u.password && !u.search && !u.hash && match
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === ONLOG_EXPRESS_API ? match[1] : null;
}

export function boundOnlogRequest(request, number, page) {
  if (request.url() !== ONLOG_EXPRESS_API || request.method() !== 'POST'
    || page && request.frame() !== page.mainFrame()) return false;
  const body = request.postData();
  if (typeof body !== 'string' || body.length > 65536) return false;
  const fields = new URLSearchParams(body);
  const allowed = new Set(['origem', 'txtObjetos', 'txtR1RastreioEncomendas', 'cf-turnstile-response']);
  const tokens = fields.getAll('cf-turnstile-response');
  return [...fields.keys()].every(k => allowed.has(k))
    && fields.getAll('origem').length === 1 && fields.get('origem') === 'form_rastreio_encomendas_sem_dados_destinatario'
    && fields.getAll('txtObjetos').length === 1 && fields.get('txtObjetos') === number
    && fields.getAll('txtR1RastreioEncomendas').length <= 1 && !fields.get('txtR1RastreioEncomendas')
    && tokens.length >= 1 && tokens.length <= 2 && tokens.every(t => t.length > 0 && t.length <= 16384);
}

/** Runs in the page realm: isolated evaluation cannot read its jQuery closure or Turnstile API. */
export function installOnlogNativeBridge() {
  if (location.origin !== 'https://conecta.log.br' || location.pathname !== '/rastreio.php') return;
  let attempts = 0;
  const setup = setInterval(() => {
    if (++attempts > 100) { clearInterval(setup); return; }
    if (!document.documentElement) return;
    clearInterval(setup);
    const script = document.createElement('script');
    script.textContent = `(${function onlogPageState() {
      const events = []; let invoked = false, invocationFailed = false, ticks = 0;
      window.addEventListener('message', event => {
        if (event.origin !== 'https://challenges.cloudflare.com' || !event.data || typeof event.data !== 'object') return;
        const d = event.data, code = String(d.code ?? d.errorCode ?? '');
        const name = typeof d.event === 'string' && /^[A-Za-z]{1,40}$/.test(d.event) ? d.event : null;
        if (/^\d{3,7}$/.test(code)) events.push({ event: name, code });
        else if (name && name !== 'food') events.push({ event: name });
        if (events.length > 12) events.shift();
      });
      const timer = setInterval(() => {
        const box = document.querySelector('#turnstile-widget')?.getBoundingClientRect();
        const ready = typeof window.onTurnstileLoad === 'function' && typeof window.turnstile?.render === 'function';
        // The asynchronous CDN onload can precede the jQuery-ready callback definition.
        // Invoke the existing initializer once only when its widget has not rendered.
        if (!invoked && ticks > 20 && ready && box && box.height < 1) {
          invoked = true;
          try { window.onTurnstileLoad(); } catch { invocationFailed = true; }
        }
        document.documentElement.setAttribute('data-onlog-guest-state', JSON.stringify({ ready, invoked, invocationFailed,
          widget: !!box && box.height > 1, events }));
        if (++ticks > 350) clearInterval(timer);
      }, 200);
    }.toString()})();`;
    document.documentElement.appendChild(script); script.remove();
  }, 50);
}

/** Page-side projection excludes object aliases, partner branding, links and unrelated party fields. */
export function projectOnlogReply(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(k => !['sucesso', 'html', 'mensagem'].includes(k))) return 'null';
  if (payload.sucesso === false) {
    if (Object.hasOwn(payload, 'html') || typeof payload.mensagem !== 'string' || payload.mensagem.length > 2000) return 'null';
    return JSON.stringify({ sucesso: false, mensagem: payload.mensagem });
  }
  if (payload.sucesso !== true || typeof payload.html !== 'string'
    || Object.hasOwn(payload, 'mensagem') && payload.mensagem !== '') return 'null';
  const doc = new DOMParser().parseFromString(payload.html, 'text/html');
  const escape = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const headers = [...doc.querySelectorAll('h3')];
  const wrappers = [...doc.querySelectorAll('.rastreio-wrapper')];
  if (wrappers.reduce((n, w) => n + w.querySelectorAll('.rastreio-item').length, 0) !== doc.querySelectorAll('.rastreio-item').length) return 'null';
  let html = headers.map(h => `<h3>${escape(h.textContent ?? '')}</h3>`).join('');
  for (const wrapper of wrappers) {
    const items = [...wrapper.querySelectorAll('.rastreio-item')];
    if (items.length > 500) return 'null';
    html += '<div class="rastreio-wrapper">';
    for (const item of items) {
      const texts = [...item.querySelectorAll('.texto-rastreio')];
      if (texts.length !== 1) return 'null';
      const text = texts[0], status = [...text.children].filter(e => e.matches('span.position-relative'));
      const place = [...text.children].filter(e => e.matches('span.text-sm'));
      if (status.length !== 1 || place.length > 1) return 'null';
      const clock = [...text.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('');
      html += `<div class="rastreio-item${item.classList.contains('active') ? ' active' : ''}"><div class="texto-rastreio">`
        + `<span class="position-relative">${escape(status[0].textContent ?? '')}</span>`
        + (place.length ? `<span class="text-sm">${escape(place[0].textContent ?? '')}</span>` : '')
        + `${escape(clock)}</div></div>`;
    }
    html += '</div>';
  }
  return JSON.stringify({ sucesso: true, html });
}

export async function runOnlogExpressBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = onlogExpressBrowserNumber(url, capture);
  if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve;
  let page, onResponse, onRoute, accepting = true, expired = false;
  let pageStatus = 0, submitted = false, responseCount = 0, requestCount = 0, clicks = 0, lastClick = 0, totalBytes = 0;
  let runtimeFailed = false, nativeCode = null, nativeReady = false, widgetSeen = false, finish;
  const rows = [], pending = new Set();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Onlog browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'onlog-reply' : runtimeFailed ? 'onlog-runtime'
      : submitted ? 'onlog-capture_missing' : nativeCode ? 'onlog-verification_' + nativeCode : 'onlog-verification_unfinished' });
  const work = async run => {
    page = run.page;
    await page.addInitScript(installOnlogNativeBridge); left();
    const terminal = new Promise(resolve => { finish = resolve; });
    onRoute = async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      if (!accepting || expired || !boundOnlogRequest(request, number, page) || ++requestCount > 2) return route.abort();
      return route.fallback();
    };
    await page.route(/^https:\/\/(?:conecta\.log\.br|onlog\.app\.br)\//, onRoute);
    onResponse = response => {
      if (!accepting || !boundOnlogRequest(response.request(), number, page)) return;
      if (++responseCount > 2) { if (rows.length) rows.at(-1).error = 'response-limit'; finish(); return; }
      const headers = response.headers();
      const row = { url: ONLOG_EXPRESS_API, status: response.status(), trackingNumberSubmitted: number,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
        body: null, error: null, truncated: false, base64Encoded: false };
      rows.push(row);
      if (row.status !== 200) { finish(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > ONLOG_EXPRESS_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
      const task = (async () => {
        const bytes = await response.body();
        if (!accepting) return;
        totalBytes += bytes.length;
        if (bytes.length > ONLOG_EXPRESS_CAPTURE_BYTES || totalBytes > 2 * ONLOG_EXPRESS_CAPTURE_BYTES) row.truncated = true;
        else {
          const text = bytes.toString('utf8');
          if (/_cf_chl_opt|cf-chl-|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(text.slice(0, 64000))) row.error = 'challenge-html';
          else { let payload; try { payload = JSON.parse(text); } catch { row.error = 'invalid-json'; }
            if (!row.error) row.body = await page.evaluate(projectOnlogReply, payload); }
        }
      })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    };
    page.on('response', onResponse);
    const nav = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: left(20000) });
    pageStatus = nav?.status() ?? 0; left();
    if (page.url() !== PAGE) { runtimeFailed = true; return result(); }
    if (pageStatus !== 200) return result();
    const field = page.locator('#txtObjetos');
    if (!await field.count()) {
      const html = await page.content().catch(() => '');
      runtimeFailed = !/_cf_chl_opt|cf-chl-|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(html.slice(0, 64000));
      return result();
    }
    await field.fill(number, { timeout: left(5000) });
    const loaded = Date.now();
    while (accepting && !expired) {
      left();
      const raw = await page.locator('html').getAttribute(ATTRIBUTE).catch(() => null);
      let state; try { state = raw ? JSON.parse(raw) : null; } catch { /* Native state remains unready. */ }
      nativeReady ||= state?.ready === true;
      widgetSeen ||= state?.widget === true;
      if (state?.invocationFailed) { runtimeFailed = true; break; }
      nativeCode = state?.events?.find(e => ['fail', 'error'].includes(e.event) && typeof e.code === 'string' && /^\d{3,7}$/.test(e.code))?.code ?? null;
      if (nativeCode) break;
      if (await page.locator('#btnConsultar').isEnabled().catch(() => false)) {
        if (await field.inputValue() !== number) { runtimeFailed = true; break; }
        submitted = true;
        await page.locator('#btnConsultar').click({ timeout: left(3000) });
        // click() may return before the native jQuery XHR is routed: keep observing until its reply.
        await terminal;
        if (rows.at(-1)?.status !== 200 || rows.at(-1)?.error || rows.at(-1)?.truncated) {
          await page.waitForTimeout(Math.min(300, left()));
        }
        break;
      }
      if (Date.now() - loaded > 2000 && Date.now() - lastClick > 5000 && clicks < 3) {
        const box = await page.locator('#turnstile-widget').boundingBox().catch(() => null);
        if (box && box.width >= 200 && box.height >= 40 && box.height <= 160) {
          lastClick = Date.now(); clicks++;
          await page.mouse.click(box.x + 30, box.y + box.height / 2);
        }
      }
      await page.waitForTimeout(Math.min(250, left()));
    }
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    return await withHelperContext({ handle, label: 'Onlog', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
      cleanupMs: Math.min(1500, reserve), check: () => left(), closeOnAbort: true, replaceOpening: true,
      onExpire: () => { expired = true; },
      onFailure: () => {
        if (signal?.aborted) signal.throwIfAborted();
        if (!pageStatus || !submitted && !nativeReady && !widgetSeen) runtimeFailed = true;
        return result();
      },
      onStop: () => {
        accepting = false; expired = true;
        if (page && onResponse) page.off('response', onResponse);
      } }, work);
  } finally {
    for (const row of rows) if (row.status === 200 && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'onlog.verification', ready: nativeReady, widget: widgetSeen, clicks,
      submitted, requests: requestCount, responses: responseCount, nativeCode, reason: result().reason }));
  }
}
