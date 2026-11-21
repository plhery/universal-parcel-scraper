import { withHelperContext } from './helper-context.mjs';
import { keptFiles } from './kept-files.mjs';

const ORIGIN = 'https://www.track123.com';
const QUERY = `${ORIGIN}/tk/api/v2/anonymous/track/query-track-nos`;
const POLL = `${ORIGIN}/tk/api/v2/anonymous/track/polling-waybill`;
const MAX_BODY = 2_000_000;
const COURIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
// Tencent's verification client and the application Track123's pages name to it.
const VERIFICATION = 'https://turing.captcha.qcloud.com/TJCaptcha.js';
const APPLICATION = '191371042';
const VERDICT = 'data-upc-track123-verdict';
// Track123's pages ask again this long after an unfinished reply, at most this many times.
const POLL_MS = 300;
const POLLS = 100;
// Tencent's script and style files, kept between lookups.
const kept = keptFiles({ match: /^https:\/\/turing\.captcha\.(?:qcloud|gtimg)\.com\/[\w./-]{1,200}\.(?:js|css)$/ });

/** The courier code and whole number of a `/carriers/<code>#trawl-number=<number>` request, or null. */
export function track123Request(raw, capture = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const values = new URLSearchParams(url.hash.slice(1));
  const number = values.get('trawl-number');
  const code = /^\/carriers\/([^/]+)$/.exec(url.pathname)?.[1];
  return url.origin === ORIGIN && COURIER.test(code ?? '') && !url.search
    && !url.username && !url.password && [...values].length === 1
    && NUMBER.test(number ?? '')
    && capture.captureResponses?.length === 2 && capture.captureResponses[0] === QUERY
    && capture.captureResponses[1] === POLL ? { code, number } : null;
}

export function track123Number(raw, capture = {}) {
  return track123Request(raw, capture)?.number ?? null;
}

const SINES = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);
const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
/** MD5 as Track123's pages compute it: the second and third initial words differ from the standard's. */
function digest(text) {
  const bytes = Buffer.from(text, 'utf8');
  const words = new Uint32Array((((bytes.length + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < bytes.length; i += 1) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  words[words.length - 2] = (bytes.length * 8) >>> 0;
  words[words.length - 1] = Math.floor(bytes.length * 8 / 2 ** 32);
  const state = [0x67452301, 0xedcdab89, 0x98badefe, 0x10325476];
  for (let offset = 0; offset < words.length; offset += 16) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i += 1) {
      const round = i >> 4;
      const [mixed, word] = round === 0 ? [(b & c) | (~b & d), i] : round === 1 ? [(d & b) | (~d & c), (5 * i + 1) % 16]
        : round === 2 ? [b ^ c ^ d, (3 * i + 5) % 16] : [c ^ (b | ~d), (7 * i) % 16];
      const sum = (a + mixed + SINES[i] + words[offset + word]) >>> 0;
      const shift = SHIFTS[round * 4 + (i % 4)];
      [a, d, c, b] = [d, c, b, (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0];
    }
    [a, b, c, d].forEach((value, index) => { state[index] = (state[index] + value) >>> 0; });
  }
  const out = Buffer.alloc(16);
  state.forEach((value, index) => out.writeUInt32LE(value, index * 4));
  return out;
}

/** The `Track-Key` header Track123's pages send with each request: its time and its body, hashed. */
export function track123Key(body, time = String(Date.now())) {
  const stamp = digest(time);
  return stamp.toString('base64').replace(/=+$/, '') + digest(body).toString('hex') + stamp.toString('hex');
}

/** Runs inside the page: one same-origin POST whose reply is read up to a byte bound. */
export async function postTrack123({ url, body, headers, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetch(url, { method: 'POST', body, headers, credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      return { status: response.status };
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { status: 200, truncated: true };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { status: 200, text: text + decoder.decode() };
  } catch {
    return { status: 0 };
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

/** Only public history fields leave the browser; no verification or recipient data. */
export function track123Data(payload) {
  const pick = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : null;
  return { code: typeof payload?.code === 'string' && /^[A-Z0-9_]{1,30}$/.test(payload.code) ? payload.code : null,
    data: { landWaybillLists: Array.isArray(payload?.data?.landWaybillLists)
      ? payload.data.landWaybillLists.slice(0, 10).map(value => ({
        ...pick(value, ['trackingNo', 'localProviderCode', 'localProviderName', 'localProviderEnName', 'querying',
          'hasTrackingDetails', 'nodeStatus']),
        localDetails: Array.isArray(value.localDetails) ? value.localDetails.slice(0, 1001).map(event =>
          pick(event, ['trackingNo', 'eventTime', 'eventTimeUtc', 'timezone', 'eventDetail', 'desc', 'address'])) : null,
      })) : null } };
}

/** The kept copy of one of Tencent's files, while it may still be used. */
export const track123Kept = kept.get;

/** Keeps a file the browser read from Tencent whole, when its reply says for how long it may be reused. */
export const keepTrack123File = kept.keep;

/** Tencent's check on the blank page: its ticket, or null when it gives none this lookup can use. */
async function verify(page, remaining) {
  await page.addScriptTag({ url: VERIFICATION });
  // Track123's pages ask again when Tencent's service answers with its fallback ticket.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, Math.min(3000, remaining())));
    // addScriptTag executes in the page world, including when the browser's evaluate world is isolated.
    await page.addScriptTag({ content: `(()=>{const done=value=>document.documentElement.setAttribute(${JSON.stringify(VERDICT)},JSON.stringify(value));`
      + `try{window.__upcCheck&&window.__upcCheck.destroy();window.__upcCheck=new TencentCaptcha(${JSON.stringify(APPLICATION)},`
      + `verdict=>done({ret:verdict&&verdict.ret,ticket:verdict&&verdict.ticket,randstr:verdict&&verdict.randstr}),`
      + `{loading:false,userLanguage:'en'});window.__upcCheck.show()}catch(error){done({})}})()` });
    // A check that wants an answer from a visitor never gives its verdict.
    await page.waitForSelector(`html[${VERDICT}]`, { state: 'attached', timeout: Math.min(15_000, remaining()) });
    const raw = await page.locator('html').getAttribute(VERDICT);
    await page.locator('html').evaluate((element, attribute) => element.removeAttribute(attribute), VERDICT);
    let verdict;
    try { verdict = JSON.parse(raw); } catch { return null; }
    if (verdict?.ret !== 0 || !/^[\x21-\x7e]{1,2000}$/.test(verdict.ticket ?? '') || !/^[\x21-\x7e]{1,100}$/.test(verdict.randstr ?? '')) return null;
    if (!verdict.ticket.includes('trerror_')) return verdict;
  }
  return null;
}

/**
 * Track123's guest lookup without its page: Tencent's check runs on a blank document at the
 * courier page's address, then the query and its polls are sent as the page sends them.
 */
export async function runTrack123Browser({ url, capture, handle, tier, maxTimeout, installPolicy, signal }) {
  const request = track123Request(url, capture);
  if (!request) return undefined;
  const { code, number } = request;
  const pageUrl = `${ORIGIN}/carriers/${code}`;
  const started = Date.now(), entries = [];
  let expired = false, pending = false;
  const remaining = () => {
    const left = Math.floor(maxTimeout - (Date.now() - started));
    if (expired || left < 1 || signal?.aborted) throw new Error('Track123 browser ended');
    return left;
  };
  const result = () => ({ tier, status: 'success', statusCode: 200, durationMs: Date.now() - started,
    // TRAWL requires a payload to return captures instead of escalating to another tier.
    effectiveUrl: pageUrl, html: '<html><head><title>Track123 capture</title></head><body></body></html>', cookies: [],
    // A request the deadline interrupts must not leave an earlier reply as the last word.
    capturedResponses: [...entries, ...(pending ? [{ url: POLL, status: 0, headers: {}, body: null,
      error: 'track123-request-pending', trackingNumberSubmitted: number }] : [])].slice(-12) });
  if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || signal?.aborted) return result();
  return withHelperContext({ handle, label: 'Track123', timeoutMs: maxTimeout, signal, installPolicy,
    onExpire: () => { expired = true; }, onFailure: result, onStop: () => { expired = true; } }, async ({ page }) => {
    // Only the courier page's own document is supplied locally. Tencent's check and Track123's API answer as they do for the page.
    await page.route(pageUrl, route => route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' })
      : route.fallback());
    await kept.install(page);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: remaining() });
    if (page.url() !== pageUrl) return result();
    const verdict = await verify(page, remaining);
    if (!verdict) return result();
    const ask = async (target, payload, verification = {}) => {
      const body = JSON.stringify(payload);
      pending = true;
      const reply = await page.evaluate(postTrack123, { url: target, body, timeoutMs: remaining(), maxBytes: MAX_BODY,
        headers: { 'content-type': 'application/json;charset=UTF-8', accept: 'application/json, text/plain, */*',
          locale_lang: 'en_US', 'track-key': track123Key(body), ...verification } });
      remaining();
      pending = false;
      const entry = { url: target, status: Number.isInteger(reply?.status) ? reply.status : 0, headers: {}, body: null,
        truncated: reply?.truncated === true, base64Encoded: false, trackingNumberSubmitted: number };
      let data;
      if (entry.status === 0) entry.error = 'track123-request-failed';
      else if (typeof reply.text === 'string') {
        try { data = JSON.parse(reply.text); entry.body = JSON.stringify(track123Data(data)); }
        catch { entry.error = 'track123-unreadable'; }
      }
      entries.push(entry);
      if (entries.length > 12) entries.shift();
      return data;
    };
    let reply = await ask(QUERY, { logisticsCode: code, trackNos: [number] }, { randstr: verdict.randstr, ticket: verdict.ticket });
    for (let polls = 0; polls < POLLS; polls += 1) {
      const rows = reply?.code === '00000' ? reply.data?.landWaybillLists : null;
      const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
      // Anything but one unfinished shipment of this number is the last word; the adapter reads it.
      if (row?.querying !== true || row.trackingNo !== number || !/^\d{1,30}$/.test(String(row.localProviderId ?? ''))) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, remaining())));
      reply = await ask(POLL, [{ logisticsId: String(row.localProviderId), trackingNo: number }]);
    }
    return result();
  });
}
