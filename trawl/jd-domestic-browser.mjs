import { jdIconGeometry, locateJdIcon } from './jd-icon.mjs';

const PAGE = 'https://www.jdl.com/orderSearch/';
const TRACK = 'https://www.jdl.com/waybill/trackNoPin';
const PROXY = 'https://api.jdl.com/waybillQuery/trackWaybill';
const VERIFY = 'https://api.jdl.com/waybillQuery/needVerify';
const SESSION = 'https://www.jdl.com/ecology/getSession';
// The adapter sends mainland series and unseen ones; JD's international series never come here.
const NUMBER = /^JD(?:\d{13}|[A-Z]\d{12}|[A-Z]{2}\d{11})$/, INTERNATIONAL = /^JD(?:W\d{12}|AP\d{11})$/;
const MAX_BODY = 1_000_000;
const MAX_RESPONSES = 3;
const reportVerification = fields => console.warn(JSON.stringify({ level: 'warn', event: 'jd.verification', ...fields }));

export function jdDomesticNumber(raw, capture = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const number = url.searchParams.get('waybillCodes');
  return url.origin === new URL(PAGE).origin && url.pathname === '/orderSearch/' && !url.username && !url.password && !url.hash
    && [...url.searchParams].length === 1 && NUMBER.test(number ?? '') && !INTERNATIONAL.test(number)
    && capture.captureResponses?.length === 2 && capture.captureResponses[0] === TRACK && capture.captureResponses[1] === PROXY
    ? number : null;
}

// Only tracking fields cross the browser boundary. Proofs, names, phones, maps,
// signature images and attachments are deliberately not copied.
const scalar = value => typeof value === 'string' ? value.slice(0, 2000)
  : typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const fields = (source, keys) => Object.fromEntries(keys.map(key => [key, scalar(source?.[key])]).filter(([, value]) => value !== undefined));
export function jdDomesticReply(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const result = { ...fields(payload, ['code']) };
  if (!Array.isArray(payload.obj) || payload.obj.length > 5) return result;
  result.obj = payload.obj.map(item => ({
    ...fields(item, ['rawWaybillCode']), exists: typeof item?.exists === 'boolean' ? item.exists : null,
    ...(Array.isArray(item?.traceAllVoList) && { traceAllVoList: item.traceAllVoList.slice(0, 101).map(group => ({
      ...fields(group, ['category', 'categoryName', 'operateDay']),
      ...(Array.isArray(group?.traceVoList) && { traceVoList: group.traceVoList.slice(0, 201).map(row =>
        fields(row, ['operateMessage', 'createTime', 'operateTime', 'trackDay', 'trackTime', 'state'])) }),
    })) }),
  }));
  return result;
}

export function jdDisplayedPuzzle() {
  const shown = image => {
    if (!image?.complete || !image.getClientRects().length) return false;
    for (let element = image; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible' || style.opacity !== '1') return false;
    }
    return true;
  };
  if (location.origin !== 'https://www.jdl.com' || !/^\/orderSearch\/?$/.test(location.pathname)) return null;
  const modals = document.querySelectorAll('#captcha_dom #captcha_modal');
  if (modals.length !== 1) return null;
  // Inner classes vary by widget build. Keep selection inside the official modal.
  const images = [...modals[0].querySelectorAll('img')].filter(shown);
  const scenes = images.filter(e => e.naturalWidth === 275 && e.naturalHeight === 170);
  const tips = images.filter(e => e.naturalWidth === 108 && e.naturalHeight === 36);
  if (scenes.length !== 1 || tips.length !== 1) return null;
  return { scene: scenes[0].src, tip: tips[0].src };
}

/** Bind the native refresh control to the still-displayed, unanswered puzzle. */
export function jdRefreshGeometry(challenge) {
  if (location.origin !== 'https://www.jdl.com' || !/^\/orderSearch\/?$/.test(location.pathname)) return null;
  const shown = target => {
    if (!target.getClientRects().length) return false;
    for (let element = target; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible' || style.opacity !== '1') return false;
    }
    return true;
  };
  const modals = document.querySelectorAll('#captcha_dom #captcha_modal');
  if (modals.length !== 1) return null;
  const images = [...modals[0].querySelectorAll('img')].filter(e => e.complete && shown(e));
  const scenes = images.filter(e => e.naturalWidth === 275 && e.naturalHeight === 170);
  const tips = images.filter(e => e.naturalWidth === 108 && e.naturalHeight === 36);
  if (scenes.length !== 1 || tips.length !== 1
    || scenes[0].src !== challenge?.scene || tips[0].src !== challenge?.tip) return null;
  // The refresh label can sit inside nested spans; click its unique visible leaf.
  const labels = [...modals[0].querySelectorAll('span,button')].filter(e => e.textContent.trim() === '刷新' && shown(e));
  const controls = labels.filter(e => !labels.some(other => other !== e && e.contains(other)));
  if (controls.length !== 1) return null;
  const rect = controls[0].getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
}

const pause = (ms, signal) => new Promise(resolve => {
  let timer;
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
  if (signal.aborted) done();
});
async function within(operation, ms, fallback = null, signal) {
  let timer, aborted;
  try {
    if (signal?.aborted) return fallback;
    return await Promise.race([Promise.resolve().then(operation).catch(() => fallback),
      new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, ms), fallback); }),
      ...(signal ? [new Promise(resolve => {
        aborted = () => resolve(fallback);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      })] : []),
    ]);
  } finally { clearTimeout(timer); if (aborted) signal.removeEventListener('abort', aborted); }
}

/** At most two official puzzles in the original session and caller deadline. */
export async function runJdDomestic({ url, capture, handle, tier, maxTimeout, signal, installPolicy,
  locate = locateJdIcon, onVerification = reportVerification }) {
  const number = jdDomesticNumber(url, capture);
  if (!number) return undefined;
  const started = Date.now(), ending = new AbortController();
  const combined = signal ? AbortSignal.any([signal, ending.signal]) : ending.signal;
  const left = () => Math.max(1, maxTimeout - (Date.now() - started));
  const during = (operation, ms, fallback = null) => within(operation, ms, fallback, combined);
  const entries = [], pending = new Set(), allowed = new WeakSet();
  let context, page, timer, navigationStatus = 0, needVerify, session = '', sessionCount = 0;
  let accepting = true, requests = 0, blocked = 0, clicked = false, analysis = 'not_started', outcome = 'unprepared', lastResponse = 0;
  let foregroundPixels, refreshes = 0;
  const attempts = [];
  const marker = () => ({ url: PAGE, status: navigationStatus, body: null, headers: {}, truncated: false,
    base64Encoded: false, error: `jd-domestic-${outcome}` });
  const result = () => ({ tier, status: 'success', statusCode: navigationStatus, effectiveUrl: url,
    html: '', body: new Uint8Array(), cookies: [], capturedResponses: entries.length ? entries : [marker()], durationMs: Date.now() - started });
  const onResponse = response => {
    const request = response.request();
    let target;
    try { target = new URL(response.url()); } catch { return; }
    const endpoint = target.origin + target.pathname;
    if (endpoint === VERIFY || endpoint === SESSION) {
      void (async () => {
        const bytes = await during(() => response.body(), Math.min(5000, left()));
        if (!accepting || response.status() !== 200 || !bytes || bytes.length > 32_000) return;
        let data;
        try { data = JSON.parse(bytes.toString('utf8')); } catch { return; }
        if (data?.code !== 1) return;
        if (endpoint === VERIFY && typeof data.obj === 'boolean') needVerify = data.obj;
        if (endpoint === SESSION && typeof data.obj === 'string' && data.obj.length > 0 && data.obj.length < 2000) {
          sessionCount++; if (sessionCount === 1) session = data.obj;
        }
      })();
      return;
    }
    if (!allowed.has(request)) return;
    const entry = { url: endpoint, status: response.status(), body: null, headers: {},
      truncated: false, base64Encoded: false, error: null, trackingNumberSubmitted: number };
    entries.push(entry); pending.add(entry);
    void (async () => {
      try {
        const bytes = await during(() => response.body(), Math.min(5000, left()));
        if (!accepting) return;
        if (!bytes || bytes.length > MAX_BODY) { entry.truncated = true; entry.error = 'JD domestic response unreadable'; return; }
        let payload;
        try { payload = JSON.parse(bytes.toString('utf8')); } catch { entry.error = 'JD domestic response is not JSON'; return; }
        const kept = jdDomesticReply(payload);
        if (!kept) { entry.error = 'JD domestic response is not tracking data'; return; }
        entry.body = JSON.stringify(kept);
      } finally { pending.delete(entry); lastResponse = Date.now(); }
    })().catch(() => { entry.error = 'JD domestic response unreadable'; pending.delete(entry); lastResponse = Date.now(); });
  };
  const onFailed = request => {
    if (accepting && allowed.has(request)) {
      entries.push({ url: new URL(request.url()).origin + new URL(request.url()).pathname, status: 0, body: null,
        headers: {}, truncated: false, base64Encoded: false, error: 'JD domestic request failed', trackingNumberSubmitted: number });
      lastResponse = Date.now();
    }
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 5000 || combined.aborted) { outcome = 'budget'; return result(); }
    timer = setTimeout(() => ending.abort(), Math.max(1, maxTimeout - 1000));
    const created = await during(async () => {
      const target = await handle.browser.newContext();
      if (!accepting || combined.aborted) {
        await within(() => target.close(), 1000);
        return null;
      }
      return target;
    }, left());
    if (!created) { outcome = combined.aborted ? 'budget' : 'browser_failed'; return result(); }
    context = created; handle.noteTemporaryContext?.();
    page = await during(() => context.newPage(), left());
    if (!page || combined.aborted) { outcome = 'budget'; return result(); }
    if (!await during(async () => { await installPolicy?.(page); return true; }, left(), false) || combined.aborted) {
      outcome = 'budget'; return result();
    }
    await page.route(candidate => [TRACK, PROXY].includes(candidate.origin + candidate.pathname), async route => {
      const request = route.request(); let permitted = false;
      try {
        const target = new URL(request.url()), endpoint = target.origin + target.pathname;
        if (!accepting || combined.aborted || requests >= MAX_RESPONSES || sessionCount > 1) throw new Error('Stopped');
        if (endpoint === TRACK && request.method() === 'GET' && needVerify === true && clicked) {
          const q = target.searchParams;
          permitted = q.getAll('waybillCodes').length === 1 && q.get('waybillCodes') === number && q.get('sessionId') === session
            && q.get('type') === '2' && q.get('groupFlag') === 'true'
            && sessionCount === 1 && ['sessionId', 'verifyCode', 'type', 'groupFlag'].every(key => q.getAll(key).length === 1)
            && typeof q.get('verifyCode') === 'string' && q.get('verifyCode').length > 0;
        } else if (endpoint === PROXY && request.method() === 'POST' && needVerify === false) {
          const body = request.postDataJSON(), row = Array.isArray(body) && body.length === 1 ? body[0] : null;
          permitted = !!row && row.waybillCodes === number && String(row.type) === '2' && !row.pin;
        }
        if (permitted) { requests++; allowed.add(request); await route.fallback(); return; }
      } catch { /* Issued proof and request data never reach diagnostics. */ }
      blocked++; await route.abort();
    });
    page.on('response', onResponse); page.on('requestfailed', onFailed);
    // The official mounted hook reads this query and starts its own search,
    // guest session and verification callback. No page-state mutation is needed.
    const navigation = await during(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(20000, left()) }), left());
    if (combined.aborted) { outcome = 'budget'; return result(); }
    navigationStatus = navigation?.status() ?? 0;
    if (navigationStatus !== 200) { outcome = 'navigation'; return result(); }
    const readyUntil = Date.now() + Math.min(10000, left() - 1000);
    while (!combined.aborted && Date.now() < readyUntil && typeof needVerify !== 'boolean') await pause(80, combined);
    if (typeof needVerify !== 'boolean') { outcome = 'unprepared'; return result(); }
    let puzzle;
    if (needVerify) {
      const puzzleUntil = Date.now() + Math.min(10000, left() - 1000);
      while (!combined.aborted && Date.now() < puzzleUntil && !blocked) {
        if (sessionCount > 1) { outcome = 'guest_session_changed'; return result(); }
        puzzle = await during(() => page.evaluate(jdDisplayedPuzzle), Math.min(1000, left()));
        if (puzzle && sessionCount === 1) break;
        await pause(80, combined);
      }
      if (!puzzle || sessionCount !== 1) { outcome = 'unreadable'; return result(); }
      let point;
      for (let attempt = 0; attempt < 2; attempt++) {
        analysis = 'not_started'; foregroundPixels = undefined;
        point = await locate(puzzle, combined, Math.max(0, Math.min(3000, left() - 1500)), (value, count) => {
          if (['planned', 'cancelled', 'capacity', 'input_or_budget', 'timeout', 'output_limit', 'worker_error', 'unreadable',
            'geometry', 'image', 'foreground', 'matching', 'ambiguous'].includes(value)) {
            analysis = value;
            foregroundPixels = value === 'foreground' && Number.isSafeInteger(count)
              && count >= 0 && count <= 108 * 36 && (count < 60 || count > 900) ? count : undefined;
          }
        });
        attempts.push(analysis);
        if (combined.aborted) { outcome = 'budget'; return result(); }
        if (sessionCount !== 1) { outcome = 'guest_session_changed'; return result(); }
        if (blocked || requests) { outcome = 'verification_refused'; return result(); }
        if (point) break;
        // Refresh only a visual abstention, never a submitted refusal or a worker failure.
        // Leave time for image loading, a second analysis, tracking and context cleanup.
        if (attempt || left() < 14000 || !['foreground', 'matching', 'ambiguous'].includes(analysis)) break;
        const refresh = await during(() => page.evaluate(jdRefreshGeometry, puzzle), Math.min(1000, left()));
        if (combined.aborted) { outcome = 'budget'; return result(); }
        if (sessionCount !== 1) { outcome = 'guest_session_changed'; return result(); }
        if (!refresh) { outcome = 'stale_puzzle'; return result(); }
        refreshes++;
        await during(() => page.mouse.click(refresh.x, refresh.y), Math.min(1000, left()));
        const refreshUntil = Date.now() + Math.min(5000, left() - 7000);
        let previous, fresh;
        while (!combined.aborted && Date.now() < refreshUntil && !blocked) {
          if (sessionCount !== 1) { outcome = 'guest_session_changed'; return result(); }
          const next = await during(() => page.evaluate(jdDisplayedPuzzle), Math.min(1000, left()));
          if (next && next.scene !== puzzle.scene && next.tip !== puzzle.tip) {
            if (previous?.scene === next.scene && previous?.tip === next.tip) { fresh = next; break; }
            previous = next;
          } else previous = undefined;
          await pause(80, combined);
        }
        if (combined.aborted) { outcome = 'budget'; return result(); }
        if (blocked) { outcome = 'verification_refused'; return result(); }
        if (!fresh) { outcome = 'stale_puzzle'; return result(); }
        puzzle = fresh;
      }
      if (!point) { outcome = 'unreadable'; return result(); }
      const geometry = await during(() => page.evaluate(jdIconGeometry, { challenge: puzzle, point }), Math.min(1000, left()));
      if (combined.aborted) { outcome = 'budget'; return result(); }
      if (sessionCount !== 1) { outcome = 'guest_session_changed'; return result(); }
      if (blocked || requests) { outcome = 'verification_refused'; return result(); }
      if (!geometry) { outcome = 'stale_puzzle'; return result(); }
      clicked = true;
      await during(() => page.mouse.click(geometry.x, geometry.y), Math.min(3000, left()));
    }
    while (!combined.aborted && left() > 1000) {
      if (blocked) { outcome = 'verification_refused'; return result(); }
      if (entries.length && !pending.size && Date.now() - lastResponse >= 250) { outcome = 'response'; return result(); }
      await pause(80, combined);
    }
    outcome = 'budget'; return result();
  } catch {
    outcome = combined.aborted ? 'budget' : 'browser_failed'; return result();
  } finally {
    accepting = false; ending.abort(); clearTimeout(timer);
    for (const entry of pending) { entry.truncated = true; entry.error = 'JD domestic response unfinished'; }
    page?.off('response', onResponse); page?.off('requestfailed', onFailed);
    if (context) {
      let closed = false;
      await within(() => context.close().then(() => { closed = true; }), 1000);
      if (!closed) handle.requestBrowserReplacement?.('JD domestic context cleanup failed');
    }
    try { onVerification({ outcome, analysis, ...(foregroundPixels === undefined ? {} : { foregroundPixels }),
      puzzles: attempts.length, refreshes, attempts, clicked, trackingRequests: requests, blockedRequests: blocked, durationMs: Date.now() - started }); }
    catch { /* Telemetry cannot change the result. */ }
  }
}
