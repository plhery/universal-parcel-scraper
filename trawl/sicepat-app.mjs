import { withHelperContext } from './helper-context.mjs';

const PAGE = 'https://www.sicepat.com/';
const SITE_KEY = '6LfG3VIqAAAAAOZ_w59NNZIrgEu8pHKSEBZGqxTN'; // Public reCAPTCHA key shipped by the app. gitleaks:allow
export const SICEPAT_VERIFICATION = `https://www.google.com/recaptcha/api.js?render=${SITE_KEY}`;
const TOKEN = /^[A-Za-z0-9_-]{50,8192}$/;
const ATTRIBUTE = 'data-sicepat-app-verification';

export function sicepatAppRequest(url, capture = {}) {
  return url === PAGE && capture.captureResponses?.length === 1 && capture.captureResponses[0] === SICEPAT_VERIFICATION;
}

/**
 * The official app loads inline HTML with this base URL, rather than fetching the website.
 * Reproduce that guest WebView and return its fresh callback as a tagged client envelope.
 * No tracking number enters this context, and this output is not a captured carrier reply.
 */
export async function runSicepatApp({ url, capture, handle, tier, maxTimeout, installPolicy, signal }) {
  if (!sicepatAppRequest(url, capture)) return undefined;
  const start = Date.now();
  let page;
  let expired = false;
  const remaining = () => Math.max(1, Math.floor(maxTimeout - 1500 - (Date.now() - start)));
  const check = () => { signal?.throwIfAborted(); if (expired) throw new Error('SiCepat app deadline'); };
  const failed = () => ({ tier, status: 'error', durationMs: Date.now() - start,
    reason: expired ? 'SiCepat app verification budget exhausted' : 'SiCepat app verification unavailable' });
  if (!Number.isFinite(maxTimeout) || maxTimeout <= 1500 || signal?.aborted) return failed();
  return withHelperContext({ handle, label: 'SiCepat app', timeoutMs: maxTimeout - 1500, signal, installPolicy, check,
    onExpire: () => { expired = true; }, onFailure: failed,
    onStop: () => { expired = true; } }, async run => {
    page = run.page;
    // Only the app's top-level inline document is supplied locally. Google's verification still runs normally.
    await page.route(PAGE, route => route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' })
      : route.continue());
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: remaining() }); check();
    if (page.url() !== PAGE) throw new Error('Unexpected SiCepat app origin');
    await page.addScriptTag({ url: SICEPAT_VERIFICATION }); check();
    // addScriptTag executes in the page world, including when the browser's evaluate world is isolated.
    await page.addScriptTag({ content: `grecaptcha.ready(()=>grecaptcha.execute(${JSON.stringify(SITE_KEY)},{action:'checkAwb'}).then(token=>document.documentElement.setAttribute(${JSON.stringify(ATTRIBUTE)},token),()=>document.documentElement.setAttribute(${JSON.stringify(ATTRIBUTE)},'error')))` });
    await page.waitForSelector(`html[${ATTRIBUTE}]`, { state: 'attached', timeout: remaining() }); check();
    const token = await page.locator('html').getAttribute(ATTRIBUTE); check();
    await page.locator('html').evaluate((element, attribute) => element.removeAttribute(attribute), ATTRIBUTE); check();
    if (page.url() !== PAGE || typeof token !== 'string' || !TOKEN.test(token)) throw new Error('No SiCepat app token');
    return { tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: PAGE, statusCode: 200,
      html: JSON.stringify({ kind: 'sicepat-app-verification', version: 1, origin: PAGE, action: 'checkAwb', token }),
      cookies: [], capturedResponses: [] };
  });
}
