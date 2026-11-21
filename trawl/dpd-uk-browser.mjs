import { withHelperContext } from './helper-context.mjs';

const ORIGIN = 'https://track.dpd.co.uk';
const API_ORIGIN = 'https://apis.track.dpd.co.uk';
const API = `${API_ORIGIN}/v1/`;
const MAX_BODY = 1_000_000;
const MAX_ENTRIES = 10;
const CODE = /^[A-Za-z0-9*_-]{1,128}$/;

export function dpdUkBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('reference') ?? '';
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== '/' || url.hash
    || [...url.searchParams].length !== 1 || !/^(?:\d{4})?\d{10}$/.test(number)
    || capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== API) return null;
  return number;
}

/**
 * The reference search for the whole number, or a parcel's detail or events under an issued
 * code. Which codes the search issued is only known once its reply is read.
 */
export function dpdUkRequestInfo(rawUrl, number) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) return null;
  if (url.pathname === '/v1/reference') {
    const references = url.searchParams.getAll('referenceNumber'), postcodes = url.searchParams.getAll('postcode');
    return references.length === 1 && references[0] === number && postcodes.length <= 1 && !postcodes[0]
      ? { kind: 'reference' } : null;
  }
  const match = /^\/v1\/parcels\/([^/]+)(\/parcelevents)?$/.exec(url.pathname);
  let code;
  try { code = match && decodeURIComponent(match[1]); } catch { return null; }
  if (!code || !CODE.test(code)) return null;
  // The page adds a cache-busting parameter to the detail request.
  if (match[2]) return url.search ? null : { kind: 'events', code };
  return [...url.searchParams.keys()].every(key => key === '_') && url.searchParams.getAll('_').length <= 1
    ? { kind: 'detail', code } : null;
}

const parcelDigits = value => typeof value === 'string' && value.length <= 64
  ? /^(\d{14})[0-9A-Z]?$/.exec(value.replace(/\s/g, '').toUpperCase())?.[1] ?? null : null;

/** The codes a reference reply issues for the number, and whether it names exactly one parcel. */
function issuedCodes(body, number) {
  let payload;
  try { payload = JSON.parse(body); } catch { return { codes: [], single: false }; }
  const rows = Array.isArray(payload?.data) ? payload.data.slice(0, 100) : [];
  const codes = rows.filter(row => {
    const digits = parcelDigits(row?.parcelNumber);
    return digits && (number.length === 10 ? digits.slice(4) === number : digits === number)
      && typeof row.parcelCode === 'string' && CODE.test(row.parcelCode);
  }).map(row => row.parcelCode);
  return { codes, single: rows.length === 1 && codes.length === 1 };
}

/**
 * Open the public tracker for the whole number and keep the page's own reads: the reference
 * search, then the detail and events of the parcel it issued. The browser decodes the
 * compressed replies; only tracking JSON, its status and two headers leave the context.
 *
 * After a search that finds one parcel the page runs an invisible reCAPTCHA before it opens the
 * parcel, and uses the token only to log in with a postcode. Its parcel route reads the detail and
 * events without one, so the helper opens that route for the issued code itself.
 */
export async function runDpdUkBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, signal }) {
  const number = dpdUkBrowserNumber(url, capture);
  if (!number) return undefined;
  const started = Date.now(), reads = new Set(), codes = new Set();
  // Each capture with the read it answers, which stays in the context.
  const records = [];
  let page, onResponse, finish;
  let accepting = true, expired = false, opened = false, statusCode = 0, totalBytes = 0, documents = 0;
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - started)));
  // A parcel reply can arrive before the search reply is read; only the issued code's replies leave.
  const bound = () => records.filter(({ info }) => info.kind === 'reference' || codes.has(info.code)).map(({ entry }) => ({ ...entry }));
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - started,
    // TRAWL requires a body or HTML to forward captures. The rendered page holds delivery details.
    effectiveUrl: url, html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: bound() });
  const failed = () => {
    // A refusal seen before the deadline stays for the adapter to classify.
    if (bound().length) return result();
    return { tier, status: 'error', durationMs: Date.now() - started,
      reason: expired ? 'DPD UK browser budget exhausted' : 'DPD UK browser retrieval failed' };
  };
  if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || signal?.aborted) return failed();
  const terminal = new Promise(resolve => { finish = resolve; });
  // A refusal can overtake the search reply being read: end once the issued codes are known.
  const end = () => { void Promise.allSettled([...reads]).then(() => finish()); };
  const complete = () => [...codes].some(code => ['detail', 'events'].every(kind => records
    .some(({ info, entry }) => info.kind === kind && info.code === code && entry.status === 200 && entry.body !== null)));
  const openParcel = code => {
    if (opened || !accepting) return;
    opened = true;
    // The page may have opened it already, when its reCAPTCHA passed without a challenge.
    let path = '';
    try { path = new URL(page.url()).pathname; } catch { /* Keep the search page's path empty. */ }
    if (path !== '/') return;
    documents++;
    void page.goto(`${ORIGIN}/parcels/${code}`, { waitUntil: 'domcontentloaded', timeout: remaining() }).catch(() => {});
  };
  return withHelperContext({ handle, label: 'DPD UK', timeoutMs: maxTimeout, signal, installPolicy,
    onExpire: () => { expired = true; }, onFailure: failed,
    onStop: () => {
      accepting = false;
      expired = true;
      if (page && onResponse) page.off('response', onResponse);
    } }, async run => {
    page = run.page;
    onResponse = response => {
      if (!accepting) return;
      let info;
      try {
        const request = response.request();
        if (request.method() !== 'GET' || response.url() !== request.url()) return;
        info = dpdUkRequestInfo(response.url(), number);
      } catch { return; }
      if (!info) return;
      if (records.length >= MAX_ENTRIES) {
        records.at(-1).entry.error = 'DPD UK tracking response limit exceeded'; end(); accepting = false; return;
      }
      const headers = response.headers();
      const entry = { url: response.url(), status: response.status(), body: null,
        headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key])
          .map(key => [key, headers[key].slice(0, 100)])),
        truncated: false, base64Encoded: false, error: null, trackingNumberSubmitted: number };
      const record = { info, entry, document: documents };
      records.push(record);
      // A refusal or a limit ends the lookup. A 404 body says whether the number is unknown, and a
      // refusal's says who refused: the API's own notice or a page in front of it.
      if (![200, 401, 403, 404].includes(entry.status)) { end(); return; }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) {
        entry.truncated = true; end(); return;
      }
      const read = response.body().then(body => {
        if (!accepting) return;
        totalBytes += body.length;
        if (body.length > MAX_BODY || totalBytes > 3 * MAX_BODY) { entry.truncated = true; end(); return; }
        entry.body = body.toString('utf8');
        if (entry.status !== 200) { end(); return; }
        if (info.kind === 'reference') {
          const issued = issuedCodes(entry.body, number);
          issued.codes.forEach(code => codes.add(code));
          // Several parcels or none: the page lists them and opens no detail.
          if (!issued.single) end();
          else openParcel(issued.codes[0]);
        }
        if (complete()) end();
      }).catch(() => {
        if (!accepting) return;
        // Opening the parcel route drops a reply the page was still reading for the search page.
        if (record.document < documents && info.kind !== 'reference') { records.splice(records.indexOf(record), 1); return; }
        entry.error = 'DPD UK tracking response could not be read'; end();
      }).finally(() => reads.delete(read));
      reads.add(read);
    };
    page.on('response', onResponse);
    const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
    statusCode = navigation?.status() ?? 0;
    await terminal;
    return result();
  });
}
