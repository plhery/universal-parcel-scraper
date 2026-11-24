import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { withHelperContext } from './helper-context.mjs';
import { recaptchaAudioBackoff } from './recaptcha-backoff.mjs';

/** The Ministry of Communications' shipment tracker; its form posts to a server action at the page's own address. */
export const KUWAIT_POST_PAGE = 'https://moc.gov.kw/en/shipment-tracking';
const MAX_BODY = 1_000_000;
const MAX_EVENTS = 300;
const S10 = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
// The server action's id, which changes with each deployment of the site; the page sends its own.
const ACTION = /^[0-9a-f]{20,64}$/i;
const CHALLENGE = /_cf_chl_opt|cf-chl-|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected/i;
// The scan fields an adapter reads. The office's local id, the next office, the mail category,
// the item's condition and the signatory and signature stay behind.
const FIELDS = ['COUNTRY', 'COUNTRY_NM', 'EVENT_TYPE_CD', 'EVENT_TYPE_NM', 'DEFAULT_EVENT_TYPE_NM', 'EVENT_LOCAL_DT', 'LOCATION',
  'NON_DELIVERY_REASON_NM', 'NON_DELIVERY_MEASURE_NM', 'RETENTION_REASON_NM'];
const ORIGIN = 'https://moc.gov.kw';
// The page loads about fifty files of its own; pictures, fonts and media are not needed.
const MAX_RELAYED = 150;
const MAX_FILE = 5_000_000;
const SKIPPED = new Set(['image', 'media', 'font']);
const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'upgrade', 'te',
  'proxy-connection', 'content-encoding', 'trailer']);
/**
 * DigiCert Global G2 TLS RSA SHA256 2020 CA1, which moc.gov.kw's server leaves out of its chain.
 * Chrome fetches it from the address the certificate names,
 * https://cacerts.digicert.com/DigiCertGlobalG2TLSRSASHA2562020CA1-1.crt; Firefox, and so the
 * service's browser, refuses the site without it.
 */
export const DIGICERT_GLOBAL_G2_CA1 = `-----BEGIN CERTIFICATE-----
MIIEyDCCA7CgAwIBAgIQDPW9BitWAvR6uFAsI8zwZjANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0yMTAzMzAwMDAwMDBaFw0zMTAzMjkyMzU5NTlaMFkxCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxMzAxBgNVBAMTKkRpZ2lDZXJ0IEdsb2Jh
bCBHMiBUTFMgUlNBIFNIQTI1NiAyMDIwIENBMTCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAMz3EGJPprtjb+2QUlbFbSd7ehJWivH0+dbn4Y+9lavyYEEV
cNsSAPonCrVXOFt9slGTcZUOakGUWzUb+nv6u8W+JDD+Vu/E832X4xT1FE3LpxDy
FuqrIvAxIhFhaZAmunjZlx/jfWardUSVc8is/+9dCopZQ+GssjoP80j812s3wWPc
3kbW20X+fSP9kOhRBx5Ro1/tSUZUfyyIxfQTnJcVPAPooTncaQwywa8WV0yUR0J8
osicfebUTVSvQpmowQTCd5zWSOTOEeAqgJnwQ3DPP3Zr0UxJqyRewg2C/Uaoq2yT
zGJSQnWS+Jr6Xl6ysGHlHx+5fwmY6D36g39HaaECAwEAAaOCAYIwggF+MBIGA1Ud
EwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFHSFgMBmx9833s+9KTeqAx2+7c0XMB8G
A1UdIwQYMBaAFE4iVCAYlebjbuYP+vq5Eu0GF485MA4GA1UdDwEB/wQEAwIBhjAd
BgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwdgYIKwYBBQUHAQEEajBoMCQG
CCsGAQUFBzABhhhodHRwOi8vb2NzcC5kaWdpY2VydC5jb20wQAYIKwYBBQUHMAKG
NGh0dHA6Ly9jYWNlcnRzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydEdsb2JhbFJvb3RH
Mi5jcnQwQgYDVR0fBDswOTA3oDWgM4YxaHR0cDovL2NybDMuZGlnaWNlcnQuY29t
L0RpZ2lDZXJ0R2xvYmFsUm9vdEcyLmNybDA9BgNVHSAENjA0MAsGCWCGSAGG/WwC
ATAHBgVngQwBATAIBgZngQwBAgEwCAYGZ4EMAQICMAgGBmeBDAECAzANBgkqhkiG
9w0BAQsFAAOCAQEAkPFwyyiXaZd8dP3A+iZ7U6utzWX9upwGnIrXWkOH7U1MVl+t
wcW1BSAuWdH/SvWgKtiwla3JLko716f2b4gp/DA/JIS7w7d7kwcsr4drdjPtAFVS
slme5LnQ89/nD/7d+MS5EHKBCQRfz5eeLjJ1js+aWNJXMX43AYGyZm0pGrFmCW3R
bpD0ufovARTFXFZkAdl9h6g4U5+LXUZtXMYnhIHUfoyMo5tS58aI7Dd8KvvwVVo4
chDYABPPTHPbqjc1qCmBaZx2vN4Ye5DUys/vZwP9BFohFrH/6j/f3IL16/RZkiMN
JCqVJUzKoZHm1Lesh3Sz8W2jmdv51b2EQJ8HmA==
-----END CERTIFICATE-----`;
const TRUSTED = [...rootCertificates, DIGICERT_GLOBAL_G2_CA1];

/** The address the browser service knows a lookup by: the tracker with the whole item code after its hash. */
export const kuwaitPostPageUrl = number => `${KUWAIT_POST_PAGE}#${number}`;

export function kuwaitPostBrowserNumber(url, capture = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  const number = u.hash.slice(1);
  return S10.test(number) && url === kuwaitPostPageUrl(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === KUWAIT_POST_PAGE ? number : null;
}

/** The form's own server action from the main frame: the whole item code once, with one reCAPTCHA token. */
export function kuwaitPostRequestMatches(request, page, number) {
  if (request.method() !== 'POST' || request.frame() !== page.mainFrame()) return false;
  let u; try { u = new URL(request.url()); } catch { return false; }
  u.hash = '';
  if (u.href !== KUWAIT_POST_PAGE || !ACTION.test(request.headers()['next-action'] ?? '')) return false;
  let body; try { body = JSON.parse(request.postData() ?? ''); } catch { return false; }
  const fields = Array.isArray(body) && body.length === 1 && body[0] && typeof body[0] === 'object' && !Array.isArray(body[0]) ? body[0] : null;
  return !!fields && Object.keys(fields).sort().join() === 'captchaToken,trackingId' && fields.trackingId === number
    && typeof fields.captchaToken === 'string' && fields.captchaToken.length > 0;
}

/**
 * The value a server action's reply carries. The reply is React's row format: row 0 names the
 * row that holds the action's value, `{"a":"$@1",…}`, and each row is its id, a colon and JSON.
 */
export function kuwaitPostReplyValue(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const row = /^([0-9a-f]{1,8}):(.*)$/s.exec(line);
    if (!row || rows.has(row[1])) return undefined;
    rows.set(row[1], row[2]);
  }
  let head; try { head = JSON.parse(rows.get('0') ?? ''); } catch { return undefined; }
  const id = typeof head?.a === 'string' ? /^\$@([0-9a-f]{1,8})$/.exec(head.a)?.[1] : undefined;
  if (!id || id === '0' || !rows.has(id)) return undefined;
  try { return JSON.parse(rows.get(id)); } catch { return undefined; }
}

/** The reply's outcome and each scan's kept fields. */
export function projectKuwaitPostReply(value) {
  const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
  // React writes a string that starts with "$" with a second one, and other values as "$" codes.
  const text = x => typeof x === 'string' ? (x.startsWith('$$') ? x.slice(1, 201) : x.startsWith('$') ? null : x.slice(0, 200))
    : x === null || typeof x === 'number' || typeof x === 'boolean' ? x : null;
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(x, k)).map(k => [k, text(x[k])]));
  if (!record(value)) return null;
  const out = pick(value, ['success', 'message', 'retryAfterSeconds']);
  if (Object.hasOwn(value, 'data')) out.data = !Array.isArray(value.data) ? 'unreadable'
    : value.data.slice(0, MAX_EVENTS + 1).map(row => record(row) ? pick(row, FIELDS) : null);
  return JSON.stringify(out);
}

/** A reply's body as sent, decoded when the server compressed it anyway. */
function decoded(bytes, encoding) {
  const decode = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync }[String(encoding ?? '').trim().toLowerCase()];
  if (!decode) return bytes;
  // A runtime that decodes on its own leaves the header in place.
  try { return decode(bytes); } catch { return bytes; }
}

/**
 * One request of the page to moc.gov.kw, sent from the service with the intermediate the server
 * leaves out, and its reply as `route.fulfill` takes it. The lookup's own cookie jar carries the
 * site's cookies between requests; the browser gets them too.
 */
export async function relayKuwaitPostRequest(request, { timeoutMs, jar = new Map(), requestImpl = httpsRequest }) {
  const address = new URL(request.url());
  if (address.origin !== ORIGIN || !['GET', 'POST'].includes(request.method())) throw new Error('Kuwait Post relays only its own GET and POST');
  const headers = Object.fromEntries(Object.entries(await request.allHeaders()).filter(([k]) => !k.startsWith(':') && !HOP.has(k.toLowerCase())));
  const cookies = new Map(String(headers.cookie ?? '').split(';').map(c => c.trim()).filter(Boolean).map(c => [c.split('=')[0], c]));
  for (const [name, cookie] of jar) cookies.set(name, cookie);
  delete headers.cookie;
  if (cookies.size) headers.cookie = [...cookies.values()].join('; ');
  headers['accept-encoding'] = 'identity';
  const body = request.method() === 'POST' ? request.postDataBuffer() ?? Buffer.alloc(0) : undefined;
  return await new Promise((resolve, reject) => {
    let size = 0;
    const sent = requestImpl(address, { method: request.method(), headers, ca: TRUSTED, servername: address.hostname, timeout: timeoutMs }, reply => {
      const chunks = [];
      reply.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_FILE) { sent.destroy(new Error('Kuwait Post reply too large')); return; }
        chunks.push(chunk);
      });
      reply.on('error', reject);
      reply.on('end', () => {
        const out = {};
        for (const [name, value] of Object.entries(reply.headers)) {
          if (HOP.has(name) || value === undefined) continue;
          out[name] = Array.isArray(value) ? value.join('\n') : String(value);
        }
        for (const cookie of [].concat(reply.headers['set-cookie'] ?? [])) {
          const pair = String(cookie).split(';')[0].trim(), name = pair.split('=')[0];
          if (name) jar.set(name, pair);
        }
        resolve({ status: reply.statusCode ?? 0, headers: out, body: decoded(Buffer.concat(chunks), reply.headers['content-encoding']) });
      });
    });
    sent.on('timeout', () => sent.destroy(new Error('Kuwait Post relay deadline')));
    sent.on('error', reject);
    sent.end(body);
  });
}

/**
 * The tracker for one whole item code in a fresh context. The page's own requests to moc.gov.kw
 * go out through the relay, the rest through the browser. The helper enters the code, ticks the
 * reCAPTCHA checkbox, or answers its audio challenge outside the audio pause, and sends the
 * form. Only the form's server action for that code reaches the tracker, once.
 */
export async function runKuwaitPostBrowser({ url, capture, handle, tier, maxTimeout, installPolicy, signal,
  solveNativeCaptcha, audioBackoff = recaptchaAudioBackoff, relay = relayKuwaitPostRequest }) {
  const number = kuwaitPostBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now(), cleanupMs = Math.min(1500, Math.max(1, Math.floor(maxTimeout / 5)));
  const deadline = start + maxTimeout - cleanupMs, remaining = () => Math.max(1, deadline - Date.now());
  let page, expired = false, accepting = true, statusCode = 0, sent = 0, relayed = 0, verification = 'none';
  const steps = [];
  let finish; const terminal = new Promise(resolve => { finish = resolve; });
  const entries = [], jar = new Map();
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  const failed = () => statusCode || entries.length ? result()
    : { tier, status: 'error', durationMs: Date.now() - start, reason: 'Kuwait Post browser retrieval failed' };
  // The bound reply, read as it comes back: the tracker's outcome and scans, or why there are none.
  const record = reply => {
    const entry = { url: KUWAIT_POST_PAGE, status: reply?.status ?? 0, trackingNumberSubmitted: number, headers: {},
      body: null, truncated: false, base64Encoded: false, error: null };
    entries.push(entry);
    if (!reply) { entry.error = 'relay-failed'; return; }
    entry.headers = Object.fromEntries(['content-type', 'retry-after'].filter(k => reply.headers[k]).map(k => [k, reply.headers[k].slice(0, 100)]));
    if ([301, 302, 303, 307, 308].includes(reply.status)) { entry.error = 'unexpected-redirect'; return; }
    if (reply.status !== 200) return;
    if (reply.body.length > MAX_BODY) { entry.truncated = true; return; }
    const text = reply.body.toString('utf8');
    if (CHALLENGE.test(text.slice(0, 64000))) { entry.error = 'challenge-html'; return; }
    const projected = projectKuwaitPostReply(kuwaitPostReplyValue(text));
    if (projected === null) entry.error = 'invalid-reply'; else entry.body = projected;
  };
  if (!Number.isFinite(maxTimeout) || maxTimeout < 2 || signal?.aborted) return failed();
  try {
    return await withHelperContext({ handle, label: 'Kuwait Post', timeoutMs: remaining(), signal, installPolicy, cleanupMs,
      closeOnAbort: true, onExpire: () => { expired = true; }, onFailure: failed,
      onStop: () => { accepting = false; expired = true; } }, async run => {
      page = run.page;
      await page.route(/^https:\/\/moc\.gov\.kw\//, async route => {
        const request = route.request();
        let address; try { address = new URL(request.url()); } catch { return route.abort(); }
        if (address.origin !== ORIGIN) return route.fallback();
        if (expired || SKIPPED.has(request.resourceType()) || !['GET', 'POST'].includes(request.method())) return route.abort();
        const bound = request.method() === 'POST';
        if (bound && (sent >= 1 || !kuwaitPostRequestMatches(request, page, number))) return route.abort();
        if (bound) sent++;
        if (++relayed > MAX_RELAYED) return route.abort();
        let reply;
        try { reply = await relay(request, { timeoutMs: Math.min(20000, remaining()), jar }); } catch { reply = undefined; }
        if (bound && accepting) { record(reply); finish(); }
        if (!reply || expired) return route.abort().catch(() => {});
        return route.fulfill({ status: reply.status, headers: reply.headers, body: reply.body }).catch(() => {});
      });
      statusCode = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() }))?.status() ?? 0;
      if (statusCode >= 400 || expired) return result();
      // The checkbox appears once the page has hydrated, after which the form keeps what is typed.
      const anchor = 'iframe[src*="recaptcha"][src*="anchor"]';
      await page.locator(anchor).first().waitFor({ state: 'attached', timeout: Math.min(20000, remaining()) });
      await page.locator('#tracking_id').fill(number, { timeout: remaining() });
      // The checkbox passes without a picture from a home network; the audio solver is the fallback, within its pause.
      if (await audioBackoff.remainingMs() > 0 || !solveNativeCaptcha) {
        verification = 'checkbox';
        await page.frameLocator(anchor).first().locator('#recaptcha-anchor').click({ timeout: Math.min(10000, remaining()) });
        await page.waitForFunction(() => !!document.querySelector('[name="g-recaptcha-response"]')?.value, null,
          { timeout: Math.min(7000, remaining()) }).catch(() => {});
      } else {
        verification = 'audio';
        await solveNativeCaptcha(page, Math.max(1, Math.min(30000, remaining() - 5000)), event => {
          // The solver reports fixed event names only.
          if (steps.length < 20 && typeof event === 'string') steps.push(event.slice(0, 40));
          if (event === 'audio_blocked') void audioBackoff.block();
        });
      }
      if (expired || !await page.locator('[name="g-recaptcha-response"]').first().inputValue({ timeout: remaining() }).then(v => !!v, () => false)) return result();
      await page.locator('form button[type="submit"]').click({ timeout: remaining() });
      await terminal; return result();
    });
  } finally {
    console.warn(JSON.stringify({ level: 'warn', event: 'kuwait-post.lookup', lookups: sent, relayed, verification, steps, page: statusCode,
      status: entries.at(-1)?.status ?? 0 }));
  }
}
