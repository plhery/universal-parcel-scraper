export const MAGIC_TRANS_ORIGIN = 'https://magic-trans.ru';
export const MAGIC_TRANS_CAPTURE_BYTES = 512000;
// An act number, or the track number the tracker's own example shows.
const NUMBER = /^(?:\d{9}|TR\d{9}MT)$/;
const PATH = '/otsledit-gruz/';
const TOKEN_LIMIT = 8000;
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required|403 Forbidden)/i;
// The page's maps, analytics, call tracking and other forms' reCAPTCHA; Yandex's SmartCaptcha stays.
const HEAVY = /^https:\/\/(?:mc\.yandex\.(?:ru|com)|api-maps\.yandex\.ru|yandex\.ru\/map-widget|(?:[a-z0-9-]+\.)*comagic\.ru|www\.google\.com\/recaptcha|www\.gstatic\.com\/recaptcha|(?:[a-z0-9-]+\.)*googlesyndication\.com|(?:[a-z0-9-]+\.)*googletagmanager\.com|(?:[a-z0-9-]+\.)*vk\.com)[/?]/;
const LOOKUP_ROUTE = /^https:\/\/magic-trans\.ru\/otsledit-gruz\//;
const CHECKBOX = /^https:\/\/smartcaptcha\.yandexcloud\.net\/checkbox/;
const DRAG_MS = 1500, MOUSE_MS = 4000;
const CHECK = /^https:\/\/smartcaptcha\.yandexcloud\.net\/check\b/;
const DUMP = ['TrackNumber', 'ActNumber', 'DateTimeAct', 'Status', 'CurrentLocation', 'DateDeparture', 'DeliveryDate', 'PlanArrivalDay',
  'DateArrivalWarehouseRecipient', 'EstimatedDateOfReceiptOfShipment', 'DateOfIssuanceOfCargo1', 'DateOfIssue', 'DateDelivery',
  'TypeTransportation', 'TypeDelivery', 'SenderWareHouse', 'ReceiverWareHouse'];
const ROWS = new Set(['Статус груза', 'Дата сдачи груза', 'Прибытие груза на терминал', 'Ориентировочная дата выдачи', 'Дата выдачи груза',
  'Вид перевозки', 'Код груза', 'Тип доставки']);

export const magicTransPageUrl = number => `${MAGIC_TRANS_ORIGIN}${PATH}?${new URLSearchParams({ id: number })}`;

export function magicTransBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.pathname === PATH && u.searchParams.getAll('id').length === 1 ? u.searchParams.get('id') : '';
  return NUMBER.test(number) && url === magicTransPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === url ? number : null;
}

/** The page's own lookup of this number: its JSON with the number and the check's token, nothing else. */
export function boundMagicTransLookup(request, number, page) {
  if (request.method() !== 'POST' || request.url() !== magicTransPageUrl(number) || (page && request.frame() !== page.mainFrame())) return false;
  let body; try { body = JSON.parse(request.postData() ?? ''); } catch { return false; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  return keys.length === 2 && keys[0] === 'id' && keys[1] === 'ya-token' && body.id === number
    && typeof body['ya-token'] === 'string' && body['ya-token'].length > 0 && body['ya-token'].length <= TOKEN_LIMIT;
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const text = (html, limit = 160) => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<a\b[\s\S]*?<\/a>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, e) => entities[e]).replace(/\s+/g, ' ').trim().slice(0, limit);

/**
 * Tracking fields only, from the page the tracker answers with: whether it shows a result, its heading's number,
 * the status block's rows and the transport and delivery kinds, and the same fields from the record the page
 * prints in a hidden block. Weights, places, cargo names, packing, payment, addresses and phones stay behind.
 */
export function projectMagicTransReply(html) {
  if (typeof html !== 'string') return 'null';
  const start = html.indexOf('<div class="k1-tracking-wrapper"');
  if (start < 0) return JSON.stringify({ wrapper: false });
  const body = html.slice(start, start + 200000);
  const out = { wrapper: true, captchaError: /k1-captcha-error-js/.test(body) };
  const block = /<div class="k1-tracking"\s+style="([^"]*)"/.exec(body);
  out.shown = !!block && !/display\s*:\s*none/i.test(block[1]);
  const dump = /<pre>([\s\S]*?)<\/pre>/.exec(block ? body.slice(0, block.index) : '');
  if (dump) {
    out.dump = {};
    for (const [, key, value] of dump[1].matchAll(/^\s*\[(\w+)\] => ?(.*)$/gm)) {
      if (DUMP.includes(key) && !Object.hasOwn(out.dump, key)) out.dump[key] = text(value, 120);
    }
  }
  if (block) {
    const result = body.slice(block.index, block.index + 60000);
    const heading = /<h3>([\s\S]{0,200}?)<\/h3>/.exec(result);
    out.heading = heading ? text(heading[1], 80) : null;
    out.rows = [];
    for (const [, style, key, value] of result.matchAll(
      /<div class="k1-tracking__row"(?:\s+style="([^"]*)")?>\s*<div class="k1-tracking__key[^"]*">([\s\S]*?)<\/div>\s*<div class="k1-tracking__value[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g)) {
      const name = text(key, 80);
      if (!ROWS.has(name) || out.rows.length >= 20) continue;
      out.rows.push({ key: name, value: text(value), ...(/display\s*:\s*none/i.test(style ?? '') ? { hidden: true } : {}) });
    }
  }
  return JSON.stringify(out);
}

/** Puts the number in the tracker's input when the page has not, and says whether it holds it. */
export function fillMagicTransNumber(number) {
  const input = document.querySelector('.k1-tracking-form .input-tracking');
  if (!input) return false;
  if (input.value !== number) { input.value = number; input.dispatchEvent(new Event('input', { bubbles: true })); }
  return input.value === number;
}

/** The token's length once Yandex's check has passed. */
export function readMagicTransToken() {
  return (document.querySelector('.k1-tracking-form input[name=smart-token]')?.value ?? '').length;
}

/** The page's own submit handler, which posts the number with the token. */
export function submitMagicTransForm() {
  const button = document.querySelector('.k1-tracking-form .k1-tracking-check-status');
  if (!button) return false;
  button.click();
  return true;
}

/** The tracking page's own lookup, after Yandex's slider check, in a fresh context: one number, at most two lookups. */
export async function runMagicTransBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy }) {
  const number = magicTransBrowserNumber(url, capture); if (!number) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve;
  let context, page, timer, abort, onResponse, opening = false, accepting = true, expired = false, finish;
  let pageStatus = 0, lookups = 0, drags = 0, token = 0, polls = 0, stalls = 0, runtimeFailed = false;
  // Yandex's verdicts on the current page, in order: one when the widget loads, then one after each drag.
  let checks = [];
  const marks = {}, mark = name => { marks[name] ??= Date.now() - start; };
  const rows = [], pending = new Set(), closing = new WeakMap();
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Magic Trans browser deadline'); return ms; };
  const pause = ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, left())));
  // Camoufox's humanized mouse can hang on a move; a page whose mouse hangs is given up.
  const bounded = (action, ms = MOUSE_MS) => { let t; return Promise.race([action, new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error('Magic Trans mouse stalled'), { stalled: true })), Math.min(ms, left()));
  })]).finally(() => clearTimeout(t)); };
  const close = target => {
    if (closing.has(target)) return closing.get(target);
    const task = (async () => { let closed = false, t;
      try { await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { t = setTimeout(resolve, Math.max(1, Math.min(1500, reserve))); })]); }
      finally { clearTimeout(t); if (!closed && target === context) handle.requestBrowserReplacement?.('Magic Trans context cleanup failed'); }
    })(); closing.set(target, task); return task;
  };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'magic-trans-reply' : runtimeFailed ? 'magic-trans-runtime'
      : drags && !token ? 'magic-trans-unverified' : 'magic-trans-capture_missing' });
  const listen = target => response => {
    if (!accepting || target !== page) return;
    const request = response.request();
    if (CHECK.test(request.url())) {
      const verdicts = checks;
      void response.text().then(t => { if (accepting && verdicts === checks) {
        checks.push(/"status"\s*:\s*"(\w{1,20})"/.exec(t.slice(0, 4000))?.[1] ?? String(response.status())); } })
        .catch(() => { if (accepting && verdicts === checks) checks.push('unread'); });
      return;
    }
    if (!boundMagicTransLookup(request, number, target)) return;
    const headers = response.headers();
    const row = { url, status: response.status(), trackingNumberSubmitted: number,
      headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
      body: null, error: null, truncated: false, base64Encoded: false };
    rows.push(row); mark('reply');
    if (row.status !== 200) { row.body = ''; finish(); return; }
    const length = Number(headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAGIC_TRANS_CAPTURE_BYTES) { row.truncated = true; finish(); return; }
    const task = (async () => {
      const bytes = await response.body(); if (!accepting) return;
      if (bytes.length > MAGIC_TRANS_CAPTURE_BYTES) { row.truncated = true; return; }
      const html = bytes.toString('utf8');
      if (CHALLENGE.test(html.slice(0, 64000))) row.error = 'challenge-html';
      else row.body = projectMagicTransReply(html);
    })().catch(() => { if (accepting) row.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
    pending.add(task);
  };
  // A page of its own for the tracker, with only this number's lookup let out.
  const open = async () => {
    page = await context.newPage(); left(); checks = [];
    await installPolicy?.(page); left();
    await page.route(HEAVY, route => route.abort());
    await page.route(LOOKUP_ROUTE, async route => {
      const request = route.request();
      if (request.method() === 'GET' && request.url() === url && !lookups) return route.fallback();
      if (!accepting || expired || !boundMagicTransLookup(request, number, page) || ++lookups > 2) return route.abort();
      return route.fallback();
    });
    onResponse = listen(page);
    page.on('response', onResponse);
    pageStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left(); mark('page');
  };
  // Drags the check's thumb across its track the way a hand does, then waits for the token it issues.
  const slide = async () => {
    let frame;
    while (!frame) { frame = page.frames().find(f => CHECKBOX.test(f.url())); if (!frame) await pause(250); }
    mark('frame');
    const thumb = frame.locator('[role=slider]').first();
    await thumb.waitFor({ timeout: left(15000) }); left(); mark('slider');
    // A drag before the widget's first check does not reach Yandex.
    for (let i = 0; i < 24 && !checks.length; i++) await pause(250);
    for (let attempt = 0; attempt < 3 && !token; attempt++) {
      const before = checks.length;
      const knob = await thumb.boundingBox(); left();
      const track = await frame.locator('[class*=Slider]').first().boundingBox(); left();
      if (!knob || !track) throw new Error('Magic Trans check has no slider');
      const x0 = knob.x + knob.width / 2, y0 = knob.y + knob.height / 2, x1 = track.x + track.width - knob.width / 2 - 2;
      drags++; mark('drag');
      await bounded(page.mouse.move(x0, y0)); await pause(200); await bounded(page.mouse.down()); await pause(150);
      // Eased over a set time, however long the browser takes for each move.
      let moved = false;
      try {
        const began = Date.now();
        for (let i = 1, t = 0; t < 1 && i <= 60; i++) {
          t = Math.min(1, (Date.now() - began) / DRAG_MS + 1 / 60);
          await bounded(page.mouse.move(x0 + (x1 - x0) * (1 - Math.pow(1 - t, 2.2)), y0 + Math.sin(i / 4) * 1.5)); await pause(15 + Math.random() * 20);
        }
        await pause(250); moved = true;
      } finally {
        // A page whose mouse hung is given up without waiting on it again.
        if (moved) { await bounded(page.mouse.up()); mark('up'); } else void Promise.resolve().then(() => page.mouse.up()).catch(() => {});
      }
      // The token follows an ok verdict; a failed one, or none, calls for another drag.
      for (let i = 0; i < 24 && !token; i++) {
        await pause(250); token = await page.evaluate(readMagicTransToken); left(); polls++;
        const verdict = checks[before];
        if (verdict !== undefined && verdict !== 'ok' && !token) break;
        if (verdict === undefined && i >= 12) break;
      }
      if (token) mark('token');
    }
  };
  const work = async () => {
    left(); opening = true; const created = await handle.browser.newContext(); opening = false; handle.noteTemporaryContext?.();
    if (expired) { await close(created); throw new Error('Magic Trans context arrived late'); }
    context = created;
    const terminal = new Promise(resolve => { finish = resolve; });
    for (let round = 0; ; round++) {
      await open();
      if (pageStatus !== 200) return result();
      await page.bringToFront().catch(() => {}); left();
      if (!await page.evaluate(fillMagicTransNumber, number)) throw new Error('Magic Trans tracker has no input');
      left();
      try { await slide(); break; } catch (error) {
        if (!error?.stalled || round) throw error;
        // A fresh page of the same context, once.
        stalls++; const stuck = page; stuck.off('response', onResponse); void close(stuck);
      }
    }
    if (!token) return result();
    if (!await page.evaluate(submitMagicTransForm)) throw new Error('Magic Trans tracker has no button');
    await terminal;
    if (pending.size) await Promise.all([...pending]);
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start) { runtimeFailed = true; return result(); }
    const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Magic Trans browser deadline')); }, Math.max(1, deadline - Date.now()));
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
    if (opening) handle.requestBrowserReplacement?.('Magic Trans context arrived after its deadline');
    if (context) await close(context);
    for (const row of rows) if (row.status === 200 && row.body === null && !row.error && !row.truncated) row.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'magic-trans.lookup', lookups, drags, stalls, polls, token: token > 0,
      checks: checks.slice(0, 8), ms: marks, page: pageStatus, status: rows.at(-1)?.status ?? 0, reason: result().reason }));
  }
}
