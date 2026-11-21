// Static files a helper serves again from memory in a later lookup's fresh context, as a browser
// that had made the lookup before would have them in its cache. Each is kept for as long as its own
// cache headers allow and a day at most. Pages, replies, other methods and anything the server marks
// private, uncacheable or varying by request stay on the network.
const DAY_MS = 24 * 3600_000;
const HEADERS = ['content-type', 'access-control-allow-origin'];
// Request headers a file may vary by and still be reused, and the ones that make it personal.
const SHARED = new Set(['accept-encoding', 'origin']);
const PERSONAL = new Set(['*', 'cookie', 'authorization']);

/** How long a reply's headers let a cache reuse it, in milliseconds; zero when they do not. */
function lifetime(headers, now) {
  const control = headers['cache-control'] ?? '';
  if (/no-store|no-cache|private/i.test(control)) return 0;
  // A file can carry more than one lifetime; the shortest holds.
  const ages = [...control.matchAll(/(?:^|[\s,])max-age=(\d{1,9})(?=$|[\s,])/gi)].map(found => Number(found[1]));
  if (ages.length) return Math.min(Math.min(...ages) * 1000, DAY_MS);
  const served = Date.parse(headers.date ?? '') || now;
  if ('expires' in headers) {
    const until = Date.parse(headers.expires);
    return until > served ? Math.min(until - served, DAY_MS) : 0;
  }
  // Without a stated lifetime a browser reuses a file for a tenth of the time since it last changed.
  const changed = Date.parse(headers['last-modified'] ?? '');
  return changed < served ? Math.min((served - changed) / 10, DAY_MS) : 0;
}

/** A bounded store for the files whose address matches `match`, with the route that serves them. */
export function keptFiles({ match, maxBytes = 2_000_000, maxFiles = 16 }) {
  const kept = new Map();
  /** The kept copy of a file, while it may still be used. */
  const get = (url, now = Date.now()) => {
    const file = kept.get(url);
    if (file && file.until <= now) kept.delete(url);
    return kept.get(url) ?? null;
  };
  /** Keeps a file the browser read whole, when its reply says for how long it may be reused. */
  const keep = async (response, now = Date.now()) => {
    const url = response.url();
    const request = response.request();
    if (!match.test(url) || request.method() !== 'GET' || response.status() !== 200 || get(url, now)) return;
    const headers = response.headers();
    const ms = lifetime(headers, now);
    if (ms <= 0) return;
    // A file that varies by a request header is reused only by requests that, like the one that
    // read it, do not send that header.
    const varies = (headers.vary ?? '').split(',').map(name => name.trim().toLowerCase())
      .filter(name => name && !SHARED.has(name));
    if (varies.some(name => PERSONAL.has(name))) return;
    if (varies.length) {
      let sent;
      try { sent = await request.allHeaders(); } catch { return; }
      if (varies.some(name => name in sent)) return;
    }
    let body;
    try { body = await response.body(); } catch { return; }
    if (!body.length || body.length > maxBytes || get(url, now)) return;
    kept.set(url, { until: now + ms, body, varies,
      headers: Object.fromEntries(HEADERS.filter(name => headers[name]).map(name => [name, headers[name]])) });
    while (kept.size > maxFiles) kept.delete(kept.keys().next().value);
  };
  /** Whether a request may be answered with a kept file. */
  const serves = async (request, file) => {
    if (!file.varies.length) return true;
    try {
      const sent = await request.allHeaders();
      return !file.varies.some(name => name in sent);
    } catch { return false; }
  };
  /** Serves kept files to the page and keeps the ones it reads. */
  const install = async page => {
    await page.route(match, async route => {
      const request = route.request();
      const file = request.method() === 'GET' ? get(request.url()) : null;
      return file && await serves(request, file)
        ? route.fulfill({ status: 200, headers: file.headers, body: file.body }) : route.fallback();
    });
    page.on('response', response => { void keep(response); });
  };
  return { get, keep, install };
}
