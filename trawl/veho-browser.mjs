import { withHelperContext } from './helper-context.mjs';

const PAGE = 'https://track.shipveho.com/';
const HOST = 'https://content-firebaseappcheck.googleapis.com';
const EXCHANGE = /^\/v1\/projects\/veho-consumer-mobile\/apps\/[^/]{1,120}:exchangeRecaptchaEnterpriseToken$/;
/** The capture name the adapter asks for: the exchange's address without its app id and key. */
export const VEHO_ATTESTATION = `${HOST}/v1/projects/veho-consumer-mobile/`;
const MAX_BODY = 16_384;
const TOKEN = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

export function vehoBrowserRequest(rawUrl, capture = {}) {
  return rawUrl === PAGE && capture.captureResponses?.length === 1 && capture.captureResponses[0] === VEHO_ATTESTATION;
}

/**
 * Open Veho's tracker and keep the guest attestation its page obtains as it loads: the token
 * and its lifetime, or the refusal's status alone. The page is given no tracking number.
 * With `openContext`, the request's proxy carries the context.
 */
export async function runVehoBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, signal, openContext }) {
  if (!vehoBrowserRequest(url, capture)) return undefined;
  const start = Date.now();
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - start)));
  let page, observer;
  let expired = false, accepting = true, statusCode = 0;
  const entries = [];
  let finish;
  const terminal = new Promise(resolve => { finish = resolve; });
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  const failed = () => {
    // A refusal seen before the deadline still classifies the read; a half-read token does not.
    if (entries.length && entries[0].status !== 200) return result();
    return { tier, status: 'error', durationMs: Date.now() - start,
      reason: expired ? 'Veho browser budget exhausted' : 'Veho browser attestation failed' };
  };
  if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || signal?.aborted) return failed();
  return withHelperContext({ handle, label: 'Veho', timeoutMs: maxTimeout, signal, openContext, installPolicy,
    onExpire: () => { expired = true; }, onFailure: failed,
    onStop: () => {
      accepting = false; expired = true;
      if (page && observer) page.off('response', observer);
    } }, async run => {
    page = run.page;
    observer = response => {
      if (!accepting) return;
      let endpoint;
      try { endpoint = new URL(response.url()); } catch { return; }
      if (endpoint.origin !== HOST || endpoint.username || endpoint.password || !EXCHANGE.test(endpoint.pathname)
        || response.request().method() !== 'POST') return;
      // The page's first answer stands: its own retries after a refusal are not waited for.
      accepting = false;
      const headers = response.headers();
      const entry = { url: VEHO_ATTESTATION, status: response.status(), body: null,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key]).map(key => [key, headers[key].slice(0, 100)])),
        truncated: false, base64Encoded: false, error: null };
      entries.push(entry);
      if (entry.status !== 200) { finish(); return; }
      void response.body().then(body => {
        if (body.length > MAX_BODY) { entry.truncated = true; return; }
        let payload;
        try { payload = JSON.parse(body.toString('utf8')); } catch { /* Reported below. */ }
        if (typeof payload?.token === 'string' && payload.token.length <= 4096 && TOKEN.test(payload.token)
          && typeof payload.ttl === 'string' && /^\d{1,7}s$/.test(payload.ttl)) {
          entry.body = JSON.stringify({ token: payload.token, ttl: payload.ttl });
        } else entry.error = 'Veho attestation was not a token';
      }).catch(() => { entry.error = 'Veho attestation could not be read'; }).then(finish);
    };
    page.on('response', observer);
    const navigation = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: remaining() });
    statusCode = navigation?.status() ?? 0;
    if (expired || statusCode !== 200) return result();
    await terminal;
    return result();
  });
}
