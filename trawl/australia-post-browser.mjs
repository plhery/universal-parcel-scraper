import { attachTrackingCapture, australiaPostClientKnown } from './tracking-capture.mjs';

/**
 * Through a proxy, whose traffic is paid by the byte, the page loads only the tracking page's
 * document, DataDome's tag, reports and device check, the tracking request, and the application
 * module while this process has not read its key. Images, fonts, styles, analytics, chat and
 * account frames are refused: a full page costs about 4 MB, this one about 0.1 MB.
 */
export function australiaPostProxyAllows(request, pageUrl) {
  let url;
  try { url = new URL(request.url()); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  // DataDome: the tag, its reports and the device check that clears the tracking request.
  if (url.origin === 'https://dd.auspost.com.au' || /^(?:[a-z0-9-]+\.)?captcha-delivery\.com$/.test(url.hostname) && !url.port) return true;
  if (url.origin === 'https://digitalapi.auspost.com.au') return url.pathname === '/shipments-gateway/v1/watchlist/shipments';
  if (url.origin !== 'https://auspost.com.au') return false;
  if (request.resourceType() === 'document') return request.isNavigationRequest() && url.href === pageUrl;
  return request.resourceType() === 'script' && /^\/mypost\/track\/assets\/index-[\w-]+\.js$/.test(url.pathname)
    && !url.search && !australiaPostClientKnown(url.pathname);
}

/** Only the carrier's public detail page and its exact anonymous query opt in. */
export function australiaPostBrowserRequest(rawUrl, capture = {}, { proxied = false } = {}) {
  // Stateful or explicitly awaited proxy reads keep the generic context behavior.
  if (proxied && (capture.cookies?.length || capture.sessionStorage?.size || capture.sessionPage
    || capture.contentWaitForSelector || capture.followMetaRefresh)) return false;
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.origin !== 'https://auspost.com.au' || url.username || url.password || url.search || url.hash) return false;
  const number = /^\/mypost\/track\/details\/((?=[A-Z0-9]*\d)[A-Z0-9]{10,34})\/?$/.exec(url.pathname)?.[1];
  const api = `https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments?trackingIds=${number}`;
  return Boolean(number && capture.captureResponses?.length === 1 && capture.captureResponses[0] === api);
}

// Browser exceptions can contain private request URLs and proxy credentials.
// Return only an allowlisted category; an HTTP-looking message alone proves no response.
function failureCategory(error) {
  try {
    const name = typeof error?.name === 'string' ? error.name : '';
    const code = typeof error?.code === 'string' ? error.code : '';
    const message = typeof error?.message === 'string' ? error.message.slice(0, 2048) : '';
    if (name === 'AbortError' || code === 'ABORT_ERR') return 'aborted';
    if (name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) return 'timeout';
    if (/Target page, context or browser has been closed|Browser has been closed|browserContext\.newPage: Target closed/.test(message)) return 'context_closed';
    if (/net::ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)\b/.test(message)) return 'proxy';
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code) || /net::ERR_NAME_NOT_RESOLVED\b/.test(message)) return 'dns';
    if (['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(code)
      || /net::ERR_CONNECTION_(?:CLOSED|RESET|REFUSED|TIMED_OUT)\b/.test(message)) return 'connection';
    if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)
      || /net::ERR_CERT_(?:AUTHORITY_INVALID|DATE_INVALID|COMMON_NAME_INVALID)\b/.test(message)) return 'tls';
  } catch { /* A thrown value need not be a native Error. */ }
  return 'unknown';
}

/** A fresh context on the leased browser; an injected context retains its proxy and fingerprint. */
export async function runAustraliaPostBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, openContext, signal,
  locale = process.env.AUSTRALIA_POST_BROWSER_LOCALE || 'de-DE',
  filterProxied = process.env.AUSTRALIA_POST_PROXY_FILTER !== 'off' }) {
  const start = Date.now();
  let context;
  let pageCapture;
  let timer;
  let abort;
  let expired = false;
  let phase = 'validation';
  const remaining = () => Math.max(1, maxTimeout - (Date.now() - start));
  const close = async target => {
    let finished = false;
    let cleanupTimer;
    try {
      await Promise.race([
        Promise.resolve().then(() => target.close()).then(() => { finished = true; }).catch(() => {}),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 1500); }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
      if (!finished) handle.requestBrowserReplacement?.('Australia Post context cleanup timed out');
    }
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout <= 0) { expired = true; throw new Error('Australia Post browser budget exhausted'); }
    if (signal?.aborted) { expired = true; signal.throwIfAborted(); }
    return await Promise.race([
      (async () => {
        // Match the verified network locale without changing the shared pool.
        // Carrier event offsets and the API's status vocabulary are independent.
        phase = 'context_creation';
        const created = openContext ? await openContext() : await handle.browser.newContext({ viewport: null, locale });
        phase = 'context_accounting';
        try { if (!openContext) handle.noteTemporaryContext?.(); }
        catch (error) { await close(created); throw error; }
        if (expired) { await close(created); throw new Error('Australia Post context arrived after its deadline'); }
        context = created;
        phase = 'page_creation';
        const page = await context.newPage();
        phase = 'policy_installation';
        await installPolicy(page);
        if (openContext && filterProxied) {
          phase = 'proxy_filter_installation';
          await page.route('**/*', route => australiaPostProxyAllows(route.request(), url)
            ? route.fallback() : route.abort('blockedbyclient'));
        }
        phase = 'capture_attachment';
        pageCapture = await attachTrackingCapture(page, url, capture);
        phase = 'navigation';
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        phase = 'capture_preparation';
        await pageCapture.prepare(remaining());
        phase = 'capture_settle';
        await pageCapture.settle(remaining());
        phase = 'capture_drain';
        const evidence = await pageCapture.drain();
        phase = 'page_content';
        const html = await page.content();
        phase = 'response_metadata';
        return { tier, status: 'success', durationMs: Date.now() - start,
          html, statusCode: navigation?.status() ?? 0, effectiveUrl: page.url(),
          cookies: [], userAgent: await page.evaluate(() => navigator.userAgent), ...evidence };
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Australia Post browser budget exhausted')); }, maxTimeout);
      }),
      ...(signal ? [new Promise((_, reject) => {
        abort = () => { expired = true; reject(new Error('Australia Post browser interrupted')); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })] : []),
    ]);
  } catch (error) {
    const category = expired ? signal?.aborted ? 'aborted' : 'budget_exhausted' : failureCategory(error);
    return { tier, status: 'error', durationMs: Date.now() - start,
      // TRAWL's reply keeps only the reason, so it names the phase the deadline reached.
      reason: expired ? `Australia Post browser budget exhausted (phase=${phase})`
        : `Australia Post browser retrieval failed (phase=${phase}; category=${category})`,
      diagnostic: { phase, category } };
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    expired = true;
    await pageCapture?.drain().catch(() => {});
    if (context) await close(context);
  }
}
