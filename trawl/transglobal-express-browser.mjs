import { parseHTML } from 'linkedom';
import { withHelperContext } from './helper-context.mjs';

export const TRANSGLOBAL_ORIGIN = 'https://www.transglobalexpress.co.uk';
/** The tracking form, which posts a reference back to itself. */
export const TRANSGLOBAL_PAGE = `${TRANSGLOBAL_ORIGIN}/track-shipment/`;
/** The result page the form sends a known reference to. */
export const TRANSGLOBAL_RESULT = `${TRANSGLOBAL_ORIGIN}/Tracking/TrackShipmentNEW/`;
const REFERENCE = /^TP-([1-9]\d{5,8})$/;
const MAX_BODY = 1_000_000;
const MAX_LEGS = 10, MAX_DAYS = 200, MAX_ROWS = 500;
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;
const REDIRECTS = [301, 302, 303, 307, 308];
const clean = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The address an adapter asks for: the form, with the whole reference to type into it. */
export const transglobalPageUrl = reference => `${TRANSGLOBAL_PAGE}?${new URLSearchParams({ reference })}`;

export function transglobalBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const reference = u.searchParams.getAll('reference').length === 1 ? u.searchParams.get('reference') : '';
  return REFERENCE.test(reference) && url === transglobalPageUrl(reference) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === TRANSGLOBAL_RESULT ? reference : null;
}

/** The form's own post of this reference: the reference and the submit button, nothing else. */
export function boundTransglobalPost(request, reference, page) {
  if (request.method() !== 'POST' || request.url() !== TRANSGLOBAL_PAGE || (page && request.frame() !== page.mainFrame())) return false;
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers()['content-type'] ?? '')) return false;
  const form = new URLSearchParams(request.postData() ?? '');
  return form.getAll('Reference').length === 1 && form.get('Reference') === reference
    && [...form.keys()].every(key => key === 'Reference' || key === 'SubmitTracking');
}

/**
 * Where the form sends a reference it knows: the result page for that order. The address also
 * carries the order's delivery postcode, which the helper checks nothing against and passes on nowhere.
 */
export function transglobalRedirectMatches(location, reference) {
  const order = REFERENCE.exec(reference)?.[1];
  let u; try { u = new URL(location, TRANSGLOBAL_PAGE); } catch { return false; }
  return Boolean(order) && u.origin + u.pathname === TRANSGLOBAL_RESULT && !u.hash && !u.username && !u.password
    && u.searchParams.getAll('orderID').length === 1 && u.searchParams.get('orderID') === order
    && [...u.searchParams.keys()].every(key => key === 'orderID' || key === 'deliveryPostcode');
}

/** The form's answer to a reference it does not know, which it shows above the form again. */
export function transglobalFormAnswer(html) {
  if (Buffer.byteLength(html) > MAX_BODY) return { kind: 'schema' };
  if (CHALLENGE.test(html.slice(0, 64_000))) return { kind: 'challenge' };
  const { document } = parseHTML(html);
  const notices = [...document.querySelectorAll('main .ErrorNotification')].map(clean);
  return notices.length === 1 && notices[0] === 'Order not found' ? { kind: 'not_found' } : { kind: 'unconfirmed' };
}

/** The legs and dated rows of the result page; images, links and the page around them stay behind. */
export function transglobalHistory(html) {
  if (Buffer.byteLength(html) > MAX_BODY) return { kind: 'schema' };
  if (CHALLENGE.test(html.slice(0, 64_000))) return { kind: 'challenge' };
  const { document } = parseHTML(html);
  const main = document.querySelector('main');
  const data = main?.querySelectorAll('.tracking_data') ?? [];
  if (!main || data.length !== 1) return { kind: 'unconfirmed' };
  main.querySelectorAll('script,style,form,input,img,.note,.scans,[style*="display:none"],[style*="display: none"]').forEach(e => e.remove());
  const legs = [...main.querySelectorAll('#tracking_journey .external_tracking')].filter(e => e.querySelector('.leg'))
    .map(e => ({ name: clean(e.querySelector('.leg')), number: clean(e.querySelector('.reference strong')) }));
  const days = [...data[0].querySelectorAll('.status_update')].map(group => ({
    date: clean(group.querySelector('.uspsHeader .time_stamp')),
    rows: [...group.querySelectorAll('.uspsTrackItem')].map(item => ({ time: clean(item.querySelector('.time_stamp')),
      description: clean(item.querySelector('.description')), location: clean(item.querySelector('.location')) })),
  }));
  if (legs.length > MAX_LEGS || days.length > MAX_DAYS || days.reduce((sum, day) => sum + day.rows.length, 0) > MAX_ROWS
    || legs.some(leg => leg.name.length > 80 || leg.number.length > 40)
    || days.some(day => day.date.length > 40 || day.rows.some(row => row.time.length > 10 || row.description.length > 500 || row.location.length > 200))) {
    return { kind: 'schema' };
  }
  return { kind: 'history', legs, days };
}

/**
 * The official form in a fresh context, once Cloudflare lets it load: it posts the whole
 * reference once and follows its own redirect to the result page of that order.
 */
export async function runTransglobalBrowser({ url, capture, handle, tier, maxTimeout, signal, installPolicy, waitCloudflare }) {
  const reference = transglobalBrowserNumber(url, capture); if (!reference) return undefined;
  signal?.throwIfAborted();
  const start = Date.now(), reserve = Math.min(2000, Math.max(25, Math.floor(maxTimeout / 10)));
  const deadline = start + maxTimeout - reserve;
  let page, onResponse, accepting = true, expired = false, finish, posts = 0, pageStatus = 0, phase = 'setup';
  let post, redirected = false;
  const rows = [], pending = new Set();
  const terminal = new Promise(resolve => { finish = resolve; });
  const left = (cap = 60000) => { signal?.throwIfAborted(); const ms = Math.min(cap, deadline - Date.now());
    if (expired || ms <= 0) throw new Error('Transglobal browser deadline'); return ms; };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    statusCode: pageStatus, html: '', body: new Uint8Array(), cookies: [], capturedResponses: rows,
    reason: rows.length ? 'transglobal-reply' : `transglobal-${phase}` });
  const row = (status, headers) => {
    // The client keeps a bound number of letters and digits alone: the reference without its hyphen.
    const entry = { url: TRANSGLOBAL_RESULT, status, trackingNumberSubmitted: reference.replace('-', ''),
      headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k]).map(k => [k, headers[k].slice(0, 100)])),
      body: null, error: null, truncated: false, base64Encoded: false };
    rows.push(entry);
    return entry;
  };
  const read = (response, entry, project) => {
    const length = Number(response.headers()['content-length'] ?? 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY) { entry.truncated = true; finish(); return; }
    const task = response.body().then(bytes => {
      if (!accepting) return;
      if (bytes.length > MAX_BODY) { entry.truncated = true; return; }
      const answer = project(bytes.toString('utf8'));
      if (answer.kind === 'challenge') { entry.error = 'challenge-html'; entry.body = ''; return; }
      entry.body = JSON.stringify(answer);
    }).catch(() => { if (accepting) entry.error = 'body-read'; }).finally(() => { pending.delete(task); finish(); });
    pending.add(task);
  };
  const work = async run => {
    page = run.page;
    // One post of this reference; any other post to the form goes nowhere.
    await page.route(address => address.href === TRANSGLOBAL_PAGE, async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      if (!accepting || expired || posts >= 1 || !boundTransglobalPost(request, reference, page)) return route.abort();
      posts++; post = request;
      return route.fallback();
    });
    onResponse = response => {
      if (!accepting) return;
      const request = response.request(), headers = response.headers(), status = response.status();
      if (post && request === post) {
        if (REDIRECTS.includes(status)) {
          // The address names the order's postcode, so no row keeps it.
          if (!transglobalRedirectMatches(headers.location ?? '', reference)) { row(status, {}).error = 'unexpected-redirect'; finish(); }
          else redirected = true;
          return;
        }
        const entry = row(status, headers);
        if (status === 200) read(response, entry, transglobalFormAnswer); else { entry.body = ''; finish(); }
        return;
      }
      if (!redirected || request.redirectedFrom() !== post || request.method() !== 'GET') return;
      const entry = row(status, headers);
      let address; try { address = new URL(response.url()); } catch { address = null; }
      if (!address || address.origin + address.pathname !== TRANSGLOBAL_RESULT) { entry.error = 'unexpected-redirect'; finish(); return; }
      if (REDIRECTS.includes(status)) { entry.error = 'unexpected-redirect'; finish(); return; }
      if (status === 200) read(response, entry, transglobalHistory); else { entry.body = ''; finish(); }
    };
    page.on('response', onResponse);
    phase = 'navigation';
    pageStatus = (await page.goto(TRANSGLOBAL_PAGE, { waitUntil: 'domcontentloaded', timeout: left(25000) }))?.status() ?? 0;
    left();
    phase = 'verification';
    if (await waitCloudflare(page, left(25000), TRANSGLOBAL_PAGE) !== 'ok') return result();
    phase = 'form';
    await page.locator('#Reference').waitFor({ state: 'attached', timeout: left(15000) });
    await page.locator('#Reference').fill(reference, { timeout: left(5000) });
    // The visible button clicks a hidden submit input, which a cookie banner may cover.
    const submitted = await page.evaluate(([expected, action]) => {
      const field = document.querySelector('input#Reference[name="Reference"]');
      const button = document.querySelector('input#SubmitTracking[type="submit"]');
      const form = field?.form;
      if (!form || button?.form !== form || field.value !== expected || form.method.toUpperCase() !== 'POST' || form.action !== action) return false;
      button.click();
      return true;
    }, [reference, TRANSGLOBAL_PAGE]);
    if (!submitted) return result();
    phase = 'capture_missing';
    await Promise.race([terminal, page.waitForTimeout(left())]);
    if (pending.size) await Promise.all([...pending]);
    return result();
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || deadline <= start || typeof waitCloudflare !== 'function') {
      phase = 'runtime'; return result();
    }
    return await withHelperContext({ handle, label: 'Transglobal', timeoutMs: Math.max(1, deadline - Date.now()), signal, installPolicy,
      cleanupMs: Math.min(1500, reserve), check: () => left(), closeOnAbort: true, replaceOpening: true,
      onExpire: () => { expired = true; },
      onFailure: () => {
        if (signal?.aborted) signal.throwIfAborted();
        if (!pageStatus) phase = 'runtime';
        return result();
      },
      onStop: () => {
        accepting = false; expired = true;
        if (page && onResponse) page.off('response', onResponse);
      } }, work);
  } finally {
    for (const entry of rows) if (entry.status === 200 && entry.body === null && !entry.error && !entry.truncated) entry.error = 'capture-incomplete';
    console.warn(JSON.stringify({ level: 'warn', event: 'transglobal.lookup', posts, page: pageStatus, status: rows.at(-1)?.status ?? 0,
      reason: result().reason }));
  }
}
