const ORIGIN = 'https://mailamericas.com';
const API = `${ORIGIN}/api/tracking`;
const MAX_BODY = 512 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function mailamericasBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('number_id') ?? '';
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== '/tracking' || url.hash
    || [...url.searchParams].length !== 1 || !/^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/.test(number)
    || capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== API) return null;
  return number;
}

/** Keep tracking fields only; recipient, proof and verification fields never leave the context. */
export function projectMailamericas(payload) {
  if (!record(payload)) return null;
  if (payload.data === null) return { data: null, ...(payload.error ? { error: true } : {}) };
  if (!record(payload.data)) return {};
  const data = payload.data;
  const pick = (row, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(row, key))
    .map(key => [key, record(row[key]) || Array.isArray(row[key]) ? null : row[key]]));
  const projected = pick(data, ['trackingNumber', 'status', 'origin', 'destination', 'state', 'service',
    'estimatedDelivery', 'isRetainedAtOrigin', 'isCustomsIntervention']);
  projected.events = Array.isArray(data.events) && data.events.length <= 500 ? data.events.map(row => {
    if (!record(row)) return null;
    const scan = pick(row, ['date', 'time', 'code', 'status', 'description', 'location']);
    // The adapter applies the same wording policy to the carrier's HTTP reply.
    if (typeof scan.description === 'string' && /^(?:PF|LM)-/i.test(String(scan.code ?? ''))) {
      scan.description = scan.description.replace(/\s*[,;:.\-–]?\s*\b(?:by|por|pelo|pela)\b[\s\S]*$/i, '');
    }
    for (const key of ['description', 'status']) if (typeof scan[key] === 'string') {
      scan[key] = scan[key].replace(/(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi, '');
    }
    return scan;
  }) : data.events === undefined ? undefined : null;
  return { data: projected };
}

/** Let AWS's page verification finish, observing the official client's complete tracking exchange. */
export async function runMailamericasBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, signal }) {
  const number = mailamericasBrowserNumber(url, capture);
  if (!number) return undefined;
  const started = Date.now(), entries = [], pending = new Set();
  let context, page, timer, abort, onResponse, onRequest, onFailed, finish;
  let expired = false, accepting = true, statusCode = 0, totalBytes = 0;
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - started)));
  const matches = request => {
    if (request.url() !== API || request.method() !== 'POST') return false;
    try { return request.postDataJSON()?.trackingNumber === number; } catch { return false; }
  };
  const result = () => {
    const captured = entries.map(entry => ({ ...entry }));
    if (pending.size) {
      if (captured.length === 10) captured.pop();
      captured.push({ url: API, status: 0, headers: {}, body: null, error: 'tracking-request-unfinished',
        truncated: false, base64Encoded: false, trackingNumberSubmitted: number });
    }
    return { tier, status: 'success', durationMs: Date.now() - started, effectiveUrl: url,
      html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: captured };
  };
  const close = async target => {
    let closed = false, timeout;
    try {
      await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]);
    } finally {
      clearTimeout(timeout);
      if (!closed) handle.requestBrowserReplacement?.('MailAmericas context cleanup failed');
    }
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || signal?.aborted) return result();
    const terminal = new Promise(resolve => { finish = resolve; });
    const endIfComplete = () => {
      const last = entries.at(-1);
      if (!pending.size && last && ![202, 403, 405].includes(last.status)) finish();
    };
    return await Promise.race([
      (async () => {
        const created = await handle.browser.newContext();
        handle.noteTemporaryContext?.();
        if (expired) { await close(created); return result(); }
        context = created;
        page = await context.newPage();
        if (expired) return result();
        await installPolicy?.(page);
        if (expired) return result();
        onRequest = request => { if (accepting && matches(request)) pending.add(request); };
        onFailed = request => {
          if (!accepting || !matches(request)) return;
          pending.delete(request);
          if (entries.length < 10) entries.push({ url: API, status: 0, headers: {}, body: null,
            error: 'tracking-request-failed', truncated: false, base64Encoded: false, trackingNumberSubmitted: number });
          finish();
        };
        onResponse = response => {
          const request = response.request();
          if (!accepting || !matches(request) || response.url() !== API) return;
          if (entries.length >= 10) { entries.at(-1).error = 'response-limit'; accepting = false; finish(); return; }
          const headers = response.headers();
          const entry = { url: API, status: response.status(), body: null,
            headers: Object.fromEntries(['content-type', 'retry-after', 'x-amzn-waf-action'].filter(key => headers[key])
              .map(key => [key, headers[key].slice(0, 100)])),
            error: null, truncated: false, base64Encoded: false, trackingNumberSubmitted: number };
          entries.push(entry);
          if (entry.status !== 200 || headers['x-amzn-waf-action']) {
            pending.delete(request); endIfComplete(); return;
          }
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) {
            entry.truncated = true; pending.delete(request); finish(); return;
          }
          void response.body().then(body => {
            if (!accepting) return;
            totalBytes += body.length;
            if (body.length > MAX_BODY || totalBytes > 3 * MAX_BODY) entry.truncated = true;
            else {
              let payload;
              try { payload = JSON.parse(body.toString('utf8')); } catch { entry.error = 'invalid-json'; }
              if (!entry.error) entry.body = JSON.stringify(projectMailamericas(payload));
            }
          }).catch(() => { if (accepting) entry.error = 'response-unreadable'; }).finally(() => {
            pending.delete(request); if (accepting) endIfComplete();
          });
        };
        page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed);
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        await terminal;
        return result();
      })(),
      new Promise((_, reject) => {
        abort = () => { expired = true; reject(new Error('MailAmericas browser ended')); };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, maxTimeout);
      }),
    ]);
  } catch {
    return result();
  } finally {
    accepting = false; expired = true; clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    if (page && onResponse) page.off('response', onResponse);
    if (page && onRequest) page.off('request', onRequest);
    if (page && onFailed) page.off('requestfailed', onFailed);
    if (context) await close(context);
  }
}
