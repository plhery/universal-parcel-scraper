const ORIGIN = 'https://aeropost.com';
const API = `${ORIGIN}/api/tracking`;
const MAX_BODY = 1_000_000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function aeropostBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const match = /^\/en\/tracking\/(CR\d{10})$/.exec(url.pathname);
  return url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash && match
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === API ? match[1] : null;
}

/** The shipper reply has no returned identity: bind its whole POST before projecting it. */
export function aeropostRequestMatches(request, page, number) {
  try {
    if (request.url() !== API || request.method() !== 'POST' || request.frame() !== page.mainFrame()
      || aeropostBrowserNumber(request.frame().url(), { captureResponses: [API] }) !== number) return false;
    const body = JSON.parse(request.postData() ?? '');
    return record(body) && body.trackingId === number && body.isCourier === false && body.language === 'en'
      && body.gateway === '' && typeof body.recaptchaToken === 'string' && body.recaptchaToken.length > 0;
  } catch { return false; }
}

/** Drop rendered recipient information, verification material and framework error stacks. */
export function projectAeropostTracking(raw) {
  if (!record(raw)) return {};
  const scalar = (value, max) => typeof value === 'string' && value.length <= max ? value : null;
  if (!Object.hasOwn(raw, 'events')) return { statusCode: Number.isSafeInteger(raw.statusCode) ? raw.statusCode : null,
    statusMessage: scalar(raw.statusMessage, 100) };
  return { events: Array.isArray(raw.events) && raw.events.length <= 500 ? raw.events.map(row => record(row) ? {
    code: typeof row.code === 'number' && Number.isSafeInteger(row.code) ? row.code : scalar(row.code, 16),
    status: scalar(row.status, 500), date_time: scalar(row.date_time, 64), country_code: scalar(row.country_code, 2),
  } : null) : null };
}

/** One fresh public page, at most two native reads, with cleanup inside the caller's budget. */
export async function runAeropostBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, signal }) {
  const number = aeropostBrowserNumber(url, capture);
  if (!number) return undefined;
  const started = Date.now(), entries = [], pending = new Set();
  const cleanupMs = Math.min(1500, Math.max(1, Math.floor(maxTimeout / 5)));
  const deadline = started + maxTimeout - cleanupMs;
  let context, page, timer, settleTimer, abort, onResponse, onFailed, route, finish;
  let expired = false, accepting = true, statusCode = 0, totalBytes = 0, requests = 0;
  const remaining = () => Math.max(1, Math.floor(deadline - Date.now()));
  const entryFor = (status, error = null) => ({ url: API, status, headers: {}, body: null, error,
    truncated: false, base64Encoded: false, trackingNumberSubmitted: number });
  const result = () => {
    const captured = entries.map(entry => ({ ...entry }));
    if (pending.size) captured.push(entryFor(0, 'tracking-request-unfinished'));
    return { tier, status: 'success', durationMs: Date.now() - started, effectiveUrl: url,
      html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: captured.slice(-3) };
  };
  const close = async target => {
    let closed = false, timeout;
    try { await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
      new Promise(resolve => { timeout = setTimeout(resolve, cleanupMs); })]); }
    finally { clearTimeout(timeout); if (!closed) handle.requestBrowserReplacement?.('Aeropost context cleanup failed'); }
  };
  const settle = () => {
    clearTimeout(settleTimer);
    if (!pending.size && entries.length) settleTimer = setTimeout(finish, Math.min(250, remaining()));
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 2000 || signal?.aborted) return result();
    const terminal = new Promise(resolve => { finish = resolve; });
    return await Promise.race([
      (async () => {
        const created = await handle.browser.newContext(); handle.noteTemporaryContext?.();
        if (expired) { await close(created); return result(); }
        context = created; page = await context.newPage();
        if (expired) return result();
        await installPolicy?.(page);
        if (expired) return result();
        route = async intercepted => {
          const request = intercepted.request();
          if (!accepting || expired || Date.now() >= deadline || !aeropostRequestMatches(request, page, number) || requests >= 2) {
            await intercepted.abort(); return;
          }
          requests++; clearTimeout(settleTimer); pending.add(request);
          await intercepted.continue();
        };
        onFailed = request => {
          if (!accepting || !pending.has(request)) return;
          pending.delete(request); entries.push(entryFor(0, 'tracking-request-failed')); settle();
        };
        onResponse = response => {
          const request = response.request();
          if (!accepting || !pending.has(request) || response.url() !== API) return;
          const headers = response.headers(), entry = entryFor(response.status()); entries.push(entry);
          entry.headers = Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key])
            .map(key => [key, headers[key].slice(0, 100)]));
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 2 * MAX_BODY) {
            entry.truncated = true; pending.delete(request); finish(); return;
          }
          // Challenges retain status only; their tokens never leave this context.
          if (![200, 404].includes(entry.status)) { pending.delete(request); settle(); return; }
          void response.body().then(bytes => {
            if (!accepting) return;
            totalBytes += bytes.length;
            if (bytes.length > MAX_BODY || totalBytes > 2 * MAX_BODY) entry.truncated = true;
            else {
              try { entry.body = JSON.stringify(projectAeropostTracking(JSON.parse(bytes.toString('utf8')))); }
              catch { entry.error = 'invalid-json'; }
            }
          }).catch(() => { if (accepting) entry.error = 'response-unreadable'; }).finally(() => {
            pending.delete(request); if (accepting) settle();
          });
        };
        page.on('response', onResponse); page.on('requestfailed', onFailed);
        await page.route(`${API}**`, route);
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        await terminal; return result();
      })(),
      new Promise((_, reject) => {
        abort = () => { expired = true; reject(new Error('Aeropost browser ended')); };
        signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, remaining());
      }),
    ]);
  } catch { return result(); }
  finally {
    accepting = false; expired = true; clearTimeout(timer); clearTimeout(settleTimer);
    if (abort) signal?.removeEventListener('abort', abort);
    if (page && onResponse) page.off('response', onResponse);
    if (page && onFailed) page.off('requestfailed', onFailed);
    if (context) await close(context);
  }
}
