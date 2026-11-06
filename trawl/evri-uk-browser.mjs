const ORIGIN = 'https://www.evri.com';
const SEARCH = 'https://api.evri.com/customer-tracking/v1/search/';
const HISTORY = 'https://tracking.platform-apis.evri.com/v1/parcels';
const MAX_BODY = 2_000_000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const invalid = () => ({ invalid: true });

export function evriUkBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const match = /^\/track\/parcel\/([A-Z0-9]{16})\/details$/.exec(url.pathname);
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !match
    || capture.captureResponses?.length !== 2 || capture.captureResponses[0] !== SEARCH + match[1]
    || capture.captureResponses[1] !== HISTORY) return null;
  return match[1];
}

/** The search names one barcode; the history request names that whole barcode inside one URN. */
export function evriUkRequestInfo(rawUrl, number) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  if (url.origin + url.pathname === SEARCH + number && !url.search) return { kind: 'search', url: rawUrl };
  if (url.origin !== 'https://tracking.platform-apis.evri.com' || !/^\/v1\/parcels\/?$/.test(url.pathname)
    || [...url.searchParams].length !== 1 || url.searchParams.getAll('uniqueIds').length !== 1) return null;
  const urn = url.searchParams.get('uniqueIds');
  const parts = /^urn:parcel_id:barcode:date:(\d{1,30}):([A-Z0-9]{16}):(\d{4}-\d{2}-\d{2})$/.exec(urn ?? '');
  if (!parts || parts[2] !== number) return null;
  return { kind: 'history', url: rawUrl, urn };
}

export function projectEvriUkSearch(raw) {
  if (!record(raw) || !Array.isArray(raw.parcels) || raw.parcels.length > 50) return invalid();
  const parcels = [];
  for (const row of raw.parcels) {
    if (!record(row) || !record(row.brand) || !scalar(row.brand.name, 80) || !Array.isArray(row.identifiers)
      || row.identifiers.length > 50 || !row.identifiers.every(id => record(id) && scalar(id.type, 64) && scalar(id.value, 500))) return invalid();
    parcels.push({ brand: { name: row.brand.name }, identifiers: row.identifiers
      .filter(id => ['BARCODE', 'PARCEL_ID'].includes(id.type)).map(id => ({ type: id.type, value: id.value })),
      ...(row.externalRedirectUrl ? { externalRedirectUrl: 'redirected' } : {}) });
  }
  return { parcels };
}

/** Selected guest history only: no ownership, contacts, photos, GPS or delivery prose naming a person. */
export function projectEvriUkHistory(raw) {
  if (!record(raw) || !Array.isArray(raw.results) || !Array.isArray(raw.failures)
    || raw.results.length > 50 || raw.failures.length > 50) return invalid();
  const results = [];
  for (const row of raw.results) {
    if (!record(row) || !scalar(row.uniqueId, 500) || !Array.isArray(row.parcelIdentifiers)
      || row.parcelIdentifiers.length > 50 || !row.parcelIdentifiers.every(id => record(id) && scalar(id.type, 64) && scalar(id.value, 500))
      || !Array.isArray(row.trackingEvents) || row.trackingEvents.length > 500) return invalid();
    const trackingEvents = [];
    for (const event of row.trackingEvents) {
      if (!record(event) || !record(event.trackingPoint) || !record(event.trackingStage)
        || !scalar(event.dateTime, 64) || !scalar(event.trackingPoint.description, 1000)
        || !scalar(event.trackingPoint.trackingPointCode, 64) || !scalar(event.trackingStage.trackingStageCode, 64)
        || !/^[A-Za-z0-9_-]+$/.test(event.trackingPoint.trackingPointCode)
        || !/^[A-Za-z0-9_-]+$/.test(event.trackingStage.trackingStageCode)) return invalid();
      const stage = event.trackingStage.trackingStageCode;
      const description = ['5_COURIER', '5_SHOP'].includes(stage) ? 'Delivered'
        : /\b(?:delivered (?:to|by)|signed (?:for )?by)\b/i.test(event.trackingPoint.description)
          ? 'Delivery update' : event.trackingPoint.description;
      const eta = record(event.eta) && scalar(event.eta.start, 64) && scalar(event.eta.end, 64)
        ? { start: event.eta.start, end: event.eta.end } : undefined;
      trackingEvents.push({ dateTime: event.dateTime,
        trackingPoint: { trackingPointCode: event.trackingPoint.trackingPointCode, description },
        trackingStage: { trackingStageCode: stage }, ...(eta ? { eta } : {}) });
    }
    const business = row.c2cClient === false && row.returnParcel === false;
    results.push({ uniqueId: row.uniqueId, parcelIdentifiers: row.parcelIdentifiers
      .filter(id => id.type === 'BARCODE').map(id => ({ type: id.type, value: id.value })), trackingEvents,
      ...(business && record(row.sender) && scalar(row.sender.displayName, 200)
        ? { c2cClient: false, returnParcel: false, sender: { displayName: row.sender.displayName } } : {}),
      ...(record(row.service) && scalar(row.service.serviceType, 80) ? { service: { serviceType: row.service.serviceType } } : {}) });
  }
  return { results, failures: raw.failures.length ? [{}] : [] };
}

/** A fresh guest page completes its own verification; only bound, selected tracking fields leave it. */
export async function runEvriUkBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, signal }) {
  const number = evriUkBrowserNumber(url, capture);
  if (!number) return undefined;
  const started = Date.now(), entries = [], pending = new Set();
  let context, page, timer, abort, onResponse, onRequest, onFailed, finish;
  let expired = false, accepting = true, statusCode = 0, totalBytes = 0, quiet;
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - started)));
  const infoOf = request => {
    try {
      if (request.method() !== 'GET' || request.frame() !== page.mainFrame()
        || evriUkBrowserNumber(request.frame().url(), capture) !== number) return null;
      return evriUkRequestInfo(request.url(), number);
    } catch { return null; }
  };
  const matches = request => Boolean(infoOf(request));
  const result = () => {
    const captured = entries.map(entry => ({ ...entry }));
    if (pending.size) {
      if (captured.length === 10) captured.pop();
      captured.push({ url: [...pending].at(-1).url(), status: 0, headers: {}, body: null, error: 'tracking-request-unfinished',
        truncated: false, base64Encoded: false, trackingNumberSubmitted: number });
    }
    return { tier, status: 'success', durationMs: Date.now() - started, effectiveUrl: url,
      html: '', body: new Uint8Array(), statusCode: entries.some(entry => entry.status === 200) ? 200 : statusCode, cookies: [], capturedResponses: captured };
  };
  const close = async target => {
    let closed = false, timeout;
    try {
      await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]);
    } finally {
      clearTimeout(timeout);
      if (!closed) handle.requestBrowserReplacement?.('Evri UK context cleanup failed');
    }
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || signal?.aborted) return result();
    const terminal = new Promise(resolve => { finish = resolve; });
    const endIfComplete = () => {
      clearTimeout(quiet);
      const last = entries.at(-1);
      if (pending.size || !last || [0, 202, 401, 403, 405].includes(last.status)) return;
      if (last.status === 429) { finish(); return; }
      if (last.error === 'verification-required') return;
      if (last.status === 200 && !last.error && !last.truncated && typeof last.body === 'string'
        && evriUkRequestInfo(last.url, number)?.kind === 'search') {
        const payload = JSON.parse(last.body);
        if (payload.parcels?.length === 1 && payload.parcels[0].brand?.name === 'EVRI'
          && !payload.parcels[0].externalRedirectUrl) return;
      }
      quiet = setTimeout(finish, Math.min(250, remaining()));
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
        onRequest = request => { if (accepting && matches(request)) { clearTimeout(quiet); pending.add(request); } };
        onFailed = request => {
          if (!accepting || !matches(request)) return;
          pending.delete(request);
          if (entries.length < 10) entries.push({ url: request.url(), status: 0, headers: {}, body: null,
            error: 'tracking-request-failed', truncated: false, base64Encoded: false, trackingNumberSubmitted: number });
          endIfComplete();
        };
        onResponse = response => {
          const request = response.request(), info = infoOf(request);
          if (!accepting || !info || response.url() !== request.url()) return;
          if (entries.length >= 10) { entries.at(-1).error = 'response-limit'; accepting = false; pending.clear(); finish(); return; }
          const headers = response.headers();
          const entry = { url: response.url(), status: response.status(), body: null,
            headers: Object.fromEntries(['content-type', 'retry-after', 'x-amzn-waf-action'].filter(key => headers[key])
              .map(key => [key, headers[key].slice(0, 100)])),
            error: null, truncated: false, base64Encoded: false, trackingNumberSubmitted: number };
          entries.push(entry);
          if (entry.status !== 200 || headers['x-amzn-waf-action']) {
            if (headers['x-amzn-waf-action']) entry.error = 'verification-required';
            pending.delete(request); endIfComplete(); return;
          }
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 2 * MAX_BODY) {
            entry.truncated = true; pending.delete(request); finish(); return;
          }
          void response.body().then(body => {
            if (!accepting) return;
            totalBytes += body.length;
            if (body.length > MAX_BODY || totalBytes > 2 * MAX_BODY) entry.truncated = true;
            else {
              let payload;
              const text = body.toString('utf8');
              try { payload = JSON.parse(text); } catch {
                entry.error = /^\s*</.test(text) && /verify (?:you are|that you are) human|checking your browser|aws-waf-captcha|challenge-platform|access denied|request (?:was )?blocked/i.test(text)
                  ? 'verification-required' : 'invalid-json';
              }
              if (!entry.error) entry.body = JSON.stringify(info.kind === 'search' ? projectEvriUkSearch(payload) : projectEvriUkHistory(payload));
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
        abort = () => { expired = true; reject(new Error('Evri UK browser ended')); };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, maxTimeout);
      }),
    ]);
  } catch {
    return result();
  } finally {
    accepting = false; expired = true; clearTimeout(timer); clearTimeout(quiet);
    if (abort) signal?.removeEventListener('abort', abort);
    if (page && onResponse) page.off('response', onResponse);
    if (page && onRequest) page.off('request', onRequest);
    if (page && onFailed) page.off('requestfailed', onFailed);
    if (context) await close(context);
  }
}
