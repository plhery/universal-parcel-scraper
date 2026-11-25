// Stock TRAWL skips compressed bodies and settles on the first polling reply.
// This compatibility adapter observes the browser's own reply for a few exact
// tracking endpoints, each on its public page with one valid number. Every
// other capture request keeps TRAWL's stock behaviour.
import { attachRoyalMailHistoryCapture, ROYAL_MAIL_OPT_OUT } from './royal-mail-history.mjs';
import { attachSwiftxSlider, swiftxDropPhoneFragment, swiftxPhoneDigits } from './swiftx-slider.mjs';
import { attachUspsTrackingCapture } from './usps-tracking.mjs';

// TRAWL drops a result that arrives at its request deadline. End a capture's
// waits before it, so the replies already observed are still returned.
export function reserveDeadline(capture, reserveMs) {
  const early = budgetMs => Math.max(0, budgetMs - reserveMs);
  return { ...capture,
    // TRAWL asks every capture for a page archive; these keep none.
    archive: capture.archive ?? (() => undefined),
    ...(capture.prepare ? { prepare: budgetMs => capture.prepare(early(budgetMs)) } : {}),
    settle: budgetMs => capture.settle(early(budgetMs)) };
}

// TRAWL waits for a page's load event and a quiet network before it asks the
// capture anything, and a provider's page keeps loading long after its tracker
// works. A capture that knows when its page can be used ends those waits there.
const readyPages = new WeakMap();
export async function untilPageReady(wait, page) {
  const ready = page ? readyPages.get(page)?.() : undefined;
  if (!ready) return wait;
  wait.catch(() => {});
  await Promise.race([wait, ready]);
}

// Pictures, fonts, advertising and measurement on a provider's page, which no
// lookup reads. Navigations and Cloudflare's checks are never among them.
const UNREAD_TYPES = new Set(['image', 'font', 'media']);
const UNREAD_HOSTS = ['doubleclick.net', 'googlesyndication.com', 'googletagmanager.com', 'google-analytics.com',
  'fundingchoicesmessages.google.com', 'adtrafficquality.google', 'mc.yandex.ru'];
export function unreadByLookup(request) {
  let url;
  try { url = new URL(request.url()); } catch { return false; }
  if (!/^https?:$/.test(url.protocol) || request.isNavigationRequest()
    || url.hostname === 'challenges.cloudflare.com' || url.pathname.startsWith('/cdn-cgi/')) return false;
  return UNREAD_TYPES.has(request.resourceType())
    || UNREAD_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/** Australia Post's application module, whose public client configuration names the tracking API's key. */
const AUSTRALIA_POST_MODULE = /^\/mypost\/track\/assets\/index-[\w-]+\.js$/;
/** DataDome's tag reports the browser here; the answer carries the cookie the tracking request needs. */
function australiaPostReport(request) {
  try {
    const url = new URL(request.url());
    return url.origin === 'https://dd.auspost.com.au' && url.pathname.startsWith('/js/');
  } catch { return false; }
}
const AUSTRALIA_POST_CLIENT = /\bshipmentsGateway:"([A-Za-z0-9._-]{16,200})"/g;
// The key of each module this process has read, by the module's path. The module
// is served uncacheable, so a page that knows its key need not load it again.
const australiaPostClients = new Map();

/** Whether this process has read the public key of the Australia Post module at this path. */
export function australiaPostClientKnown(pathname) {
  return australiaPostClients.has(pathname);
}

function rememberAustraliaPostClient(pathname, source) {
  const matches = [...source.matchAll(AUSTRALIA_POST_CLIENT)];
  if (matches.length !== 1) return;
  australiaPostClients.delete(pathname);
  australiaPostClients.set(pathname, matches[0][1]);
  while (australiaPostClients.size > 4) australiaPostClients.delete(australiaPostClients.keys().next().value);
}

// Run inside the carrier page: its anonymous tracking API is independent of
// the optional account iframe, which can be challenged while tracking works.
// Public client configuration is taken from the module this process already
// read, else from the page's module, and is never returned.
export async function requestAustraliaPostInPage({ number, budgetMs, clients = {} }) {
  if (location.origin !== 'https://auspost.com.au' || !/^[A-Z0-9]{10,34}$/.test(number)) {
    throw new Error('Australia Post lookup context is invalid');
  }
  if (!(budgetMs > 0)) throw new Error('Australia Post lookup budget exhausted');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(budgetMs, 15_000));
  try {
    const modules = [...document.querySelectorAll('script[type="module"][src]')]
      .map(script => new URL(script.src, location.href))
      .filter(url => url.origin === location.origin && /^\/mypost\/track\/assets\/index-[\w-]+\.js$/.test(url.pathname)
        && !url.search && !url.hash);
    if (modules.length !== 1) throw new Error('Australia Post application module is missing or ambiguous');
    const known = Object.hasOwn(clients, modules[0].pathname) ? clients[modules[0].pathname] : undefined;
    const key = typeof known === 'string' && /^[A-Za-z0-9._-]{16,200}$/.test(known) ? known : await (async () => {
      const bundle = await fetch(modules[0].href, { signal: controller.signal, credentials: 'same-origin', redirect: 'error' });
      if (!bundle.ok || !bundle.body || Number(bundle.headers.get('content-length')) > 4_000_000) {
        await bundle.body?.cancel();
        throw new Error('Australia Post application module is unavailable');
      }
      const reader = bundle.body.getReader();
      const decoder = new TextDecoder();
      let source = '';
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4_000_000) {
            await reader.cancel();
            throw new Error('Australia Post application module exceeds its size limit');
          }
          source += decoder.decode(value, { stream: true });
        }
        source += decoder.decode();
      } finally { reader.releaseLock(); }
      const matches = [...source.matchAll(/\bshipmentsGateway:"([A-Za-z0-9._-]{16,200})"/g)];
      if (matches.length !== 1) throw new Error('Australia Post anonymous client configuration changed');
      return matches[0][1];
    })();
    const api = new URL('https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments');
    api.searchParams.set('trackingIds', number);
    const response = await fetch(api.href, { credentials: 'include', redirect: 'error', signal: controller.signal,
      headers: { 'api-key': key, 'Content-Type': 'application/json', AP_CHANNEL_NAME: 'WEB_DETAIL' } });
    return response.status;
  } finally { clearTimeout(timer); }
}

/** Keep DataDome's native fetch wrapper: the worker's isolated world cannot see it. */
export function requestAustraliaPostMainWorld({ number, budgetMs, clients, source }) {
  if (location.origin !== 'https://auspost.com.au' || !(budgetMs > 0)) {
    return Promise.reject(new Error('Australia Post page request context is invalid'));
  }
  const id = `au-request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const marker = document.createElement('meta');
    const script = document.createElement('script');
    marker.name = id;
    marker.dataset.state = 'pending';
    const nonce = document.querySelector('script[nonce]')?.nonce;
    if (nonce) script.nonce = nonce;
    let timer;
    const cleanup = () => { clearTimeout(timer); observer.disconnect(); marker.remove(); script.remove(); };
    const observer = new MutationObserver(() => {
      if (marker.dataset.state === 'complete') {
        const status = Number(marker.dataset.status);
        cleanup();
        resolve(status);
      } else if (marker.dataset.state === 'failed') {
        cleanup();
        reject(new Error('Australia Post page request failed'));
      }
    });
    observer.observe(marker, { attributes: true, attributeFilter: ['data-state'] });
    timer = setTimeout(() => { cleanup(); reject(new Error('Australia Post page request deadline exceeded')); }, budgetMs);
    // The caller supplies only our self-contained official request builder. The public
    // configuration and number stay in this context; no key or issued state is exported.
    script.textContent = `(()=>{const marker=document.querySelector('meta[name="${id}"]'),script=document.currentScript;Promise.resolve().then(()=>(${source})(${JSON.stringify({ number, budgetMs, clients })})).then(status=>{if(marker){marker.dataset.status=String(status);marker.dataset.state='complete'}},()=>{if(marker)marker.dataset.state='failed'}).finally(()=>script?.remove())})()`;
    document.head.append(marker, script);
  });
}

/** LBC's XML-shaped JSON, without contacts, proof links, nonces or recipient prose. */
export function projectLbcTracking(raw) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(raw) || typeof raw.success !== 'boolean') return {};
  if (!raw.success) return { success: false };
  const body = raw.data?.Body;
  if (!record(body)) return { success: true, data: { Body: {} } };
  if (Object.hasOwn(body, 'Fault')) return { success: true, data: { Body: { Fault: {} } } };
  const status = body.LBCTrackAndTraceResponse?.LBCTrackAndTraceResult?.TrackingStatus;
  if (!record(status)) return { success: true, data: { Body: {} } };
  const scalar = (value, max) => value === undefined ? undefined
    : typeof value === 'string' ? value.length <= max ? value : null
    : Array.isArray(value) && value.length === 0 ? []
    : record(value) && Object.keys(value).length === 0 ? {} : null;
  const elements = (value, limit, project) => Array.isArray(value)
    ? value.length <= limit ? value.map(item => record(item) ? project(item) : null) : [null]
    : record(value) ? Object.keys(value).length ? project(value) : {} : null;
  const details = record(status.TrackingDetails)
    ? { TrackingDetails: elements(status.TrackingDetails.TrackingDetails, 2,
      row => ({ TrackingNo: scalar(row.TrackingNo, 4096) })) } : scalar(status.TrackingDetails, 0);
  const history = record(status.TrackingHistory)
    ? { TrackingHistory: elements(status.TrackingHistory.TrackingHistory, 500, row => {
      const code = scalar(row.StatusId, 32);
      const original = scalar(row.StatusandLocation, 1000);
      const wording = typeof original !== 'string' ? original : code === '1' ? 'Delivered'
        : /^Delivered to\b/i.test(original) ? 'Delivery update'
        : /^Released to authorized representative\b/i.test(original) ? 'Released to authorized representative'
        : /^Released to\b/i.test(original) ? 'Release update' : original;
      return { StatusId: code, StatusandLocation: wording, DatePosted: scalar(row.DatePosted, 64),
        DatePostedTime: scalar(row.DatePostedTime, 64), CityName: scalar(row.CityName, 120), ProvinceName: scalar(row.ProvinceName, 120) };
    }) } : scalar(status.TrackingHistory, 0);
  return { success: true, data: { Body: { LBCTrackAndTraceResponse: { LBCTrackAndTraceResult: {
    TrackingStatus: { StatusCode: scalar(status.StatusCode, 16), TrackingDetails: details, TrackingHistory: history },
  } } } } };
}

const SITES = [
  {
    api: 'https://mydhl.express.dhl/shipmentTracking',
    provider: 'DHL Express',
    allowTextResponse: true,
    requestMethod: 'GET',
    apiForNumber(number) {
      return this.api + '?' + new URLSearchParams({ AWB: number, clientApp: 'mydhlplus', countryCode: 'gb', languageCode: 'en',
        requestAdditionalDetails: 'controlledAccessDataCodes,productCode,shipmentActivationDate,countryCodes' }).toString().replace(/%2C/g, ',');
    },
    number(page) {
      if (page.origin !== 'https://mydhl.express.dhl' || page.pathname !== '/gb/en/tracking.html' || page.search) return null;
      return /^#\/results\?id=(\d{10})$/.exec(page.hash)?.[1] ?? null;
    },
    settled(data, number) {
      return data?.results?.some(result => result.id === number) || data?.errors?.some(error => error.id === number);
    },
  },
  {
    api: 'https://services.yuntrack.com/Track/Query',
    provider: 'YunExpress',
    requestMethod: 'POST',
    number(page) {
      if (page.origin !== 'https://www.yuntrack.com' || page.pathname !== '/parcelTracking' || page.hash) return null;
      const values = [...page.searchParams];
      return values.length === 1 && values[0][0] === 'id' && /^(?:YT|JM)\d{16}$/.test(values[0][1]) ? values[0][1] : null;
    },
    requestMatches(request, number) {
      try {
        const body = request.postDataJSON();
        return Array.isArray(body?.NumberList) && body.NumberList.length === 1 && body.NumberList[0] === number;
      } catch { return false; }
    },
    settled() {
      // One posted parcel, one final envelope. The adapter binds both returned
      // identities and validates even a decoded null, array or primitive root.
      return true;
    },
  },
  {
    // The page passes Cloudflare's check, then posts one batch GraphQL query
    // for the number in its address and gets a compressed JSON reply. Given
    // the recipient's phone digits in the fragment, the helper types them
    // into the summary's field, and the page posts the query again with them.
    api: 'https://swiftx-express.com/api/graphql',
    provider: 'SwiftX',
    requestMethod: 'POST',
    number(page) {
      if (page.origin !== 'https://swiftx-express.com' || page.pathname !== '/track' || swiftxPhoneDigits(page) === undefined) return null;
      const values = [...page.searchParams];
      return values.length === 1 && values[0][0] === 'trackingNumber' && /^SWX\d{18}$/.test(values[0][1]) ? values[0][1] : null;
    },
    requestMatches(request, number, target) {
      try {
        const body = request.postDataJSON();
        const input = body?.variables?.input;
        const digits = swiftxPhoneDigits(target);
        return typeof body?.query === 'string' && /\bgetOfficialWebsiteTrackingInfoBatch\b/.test(body.query)
          && input && typeof input === 'object' && Object.keys(input).every(key => ['trackingNos', 'humanToken', 'sliderToken',
            'phoneLast4', 'unlockToken', 'unlockScope'].includes(key))
          && ['unlockToken', 'unlockScope'].every(key => input[key] == null)
          && (input.phoneLast4 == null || (Boolean(digits) && input.phoneLast4 === digits))
          && Array.isArray(input.trackingNos) && input.trackingNos.length === 1 && input.trackingNos[0] === number;
      } catch { return false; }
    },
    phoneDigitsSubmitted(request, target) {
      const digits = swiftxPhoneDigits(target);
      try { return Boolean(digits) && request.postDataJSON()?.variables?.input?.phoneLast4 === digits; }
      catch { return false; }
    },
    settled(data, number, state) {
      // One query, one final reply. The adapter binds the returned number and
      // reads the not-found notice itself. A summary for the number is where
      // the page offers its phone field.
      const results = data?.data?.getOfficialWebsiteTrackingInfoBatch?.results;
      const result = Array.isArray(results) && results.length === 1 ? results[0] : undefined;
      state.phoneOffered = result?.success === true && result.unlockStatus === 'BASIC'
        && typeof result.trackingNo === 'string' && result.trackingNo.trim().toUpperCase() === number;
      return true;
    },
    sanitize(data) {
      const batch = data?.data?.getOfficialWebsiteTrackingInfoBatch;
      if (batch && typeof batch === 'object') {
        delete batch.unlockToken;
        delete batch.unlockTokenExpiresInSeconds;
      }
    },
    async setup(page, number, state, options, target) {
      if (swiftxPhoneDigits(target)) await page.addInitScript(swiftxDropPhoneFragment);
      state.slider = attachSwiftxSlider(page, number, { signal: options.budget?.signal });
    },
    async prepare(page, number, budgetMs, { state, hasTrackingRequest, refuse }) {
      await state.slider.prepare(budgetMs, hasTrackingRequest, refuse);
    },
    // Settles on the page's first reply. Given the digits, and once, they then
    // go through the summary's own field, and the page's second reply is the
    // one that answers them.
    async unlock(page, number, budgetMs, { state, target, settle, restart, finish }) {
      const deadline = Date.now() + Math.max(0, budgetMs);
      await settle(budgetMs);
      const digits = swiftxPhoneDigits(target);
      if (!digits || !state.phoneOffered || state.phoneAttempted) return;
      state.phoneAttempted = true;
      // Leave the page time to answer the digits.
      const typing = Math.min(5000, deadline - Date.now() - 2000);
      if (typing < 500) return;
      let restarted = false;
      const submitted = await state.slider.submitPhoneDigits(digits, typing, () => { restarted = true; restart(); });
      if (submitted) await settle(Math.max(0, deadline - Date.now()));
      else if (restarted) finish();
    },
    settleAfterPrepare: false,
    cleanup(state) { state.slider?.dispose(); },
  },
  {
    api: 'https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments',
    queryNumber: true,
    protectionRetry: true,
    number(page) {
      if (page.origin !== 'https://auspost.com.au' || page.search || page.hash) return null;
      return /^\/mypost\/track\/details\/([A-Z0-9]{10,34})\/?$/.exec(page.pathname)?.[1] ?? null;
    },
    settled(data, number) {
      return Array.isArray(data) && data.some(item => Array.isArray(item?.trackingIds) && item.trackingIds.includes(number));
    },
    // Reads the key from the module the page loads, so preparation need not download it again.
    async setup(page, number, state) {
      state.onModule = response => {
        let url;
        try { url = new URL(response.url()); } catch { return; }
        if (url.origin !== 'https://auspost.com.au' || !AUSTRALIA_POST_MODULE.test(url.pathname) || url.search
          || response.status() !== 200 || australiaPostClients.has(url.pathname)) return;
        state.moduleRead = Promise.resolve().then(() => response.body()).then(body => {
          if (body.length <= 4_000_000) rememberAustraliaPostClient(url.pathname, body.toString('utf8'));
        }).catch(() => {});
      };
      page.on('response', state.onModule);
      state.reported = new Promise(resolve => {
        state.onReport = request => { if (australiaPostReport(request)) resolve(); };
      });
      page.on('requestfinished', state.onReport);
      page.on('requestfailed', state.onReport);
      state.page = page;
    },
    cleanup(state) {
      state.page?.off('response', state.onModule);
      state.page?.off('requestfinished', state.onReport);
      state.page?.off('requestfailed', state.onReport);
    },
    // A tracking request sent before DataDome's first report is answered is refused, so it waits
    // for that answer, briefly, as the page's own requests do while the application starts.
    async prepare(page, number, budgetMs, { state, finish }) {
      const deadline = Date.now() + budgetMs;
      const timers = [];
      let waited = false;
      const wait = ms => new Promise(resolve => { if (!waited) timers.push(setTimeout(resolve, ms)); else resolve(); });
      try {
        await Promise.race([
          Promise.all([state.moduleRead, state.reported?.then(() => wait(500))]),
          wait(Math.min(budgetMs / 2, 8_000)),
        ]);
      } finally {
        waited = true;
        timers.forEach(clearTimeout);
      }
      const status = await page.evaluate(requestAustraliaPostMainWorld,
        { number, budgetMs: Math.max(0, deadline - Date.now()), clients: Object.fromEntries(australiaPostClients), source: requestAustraliaPostInPage.toString() });
      // A completed refused fetch has no native retry left. A 200 waits for its
      // captured body instead, even if an earlier protection response was 403.
      if (Number.isInteger(status) && status !== 200) finish();
    },
  },
  {
    api: 'https://postal.ninja/track/get',
    checkApi: 'https://postal.ninja/track/check',
    lean: true,
    // The widget mounts its form together with its handlers.
    ready(page) {
      return page.frameLocator('iframe[title="Package tracking widget"]').locator('form.tracker button[type="submit"]')
        .waitFor({ state: 'visible', timeout: 15_000 });
    },
    number(page) {
      if (page.origin !== 'https://postal.ninja' || page.pathname !== '/en/tools' || page.search) return null;
      // Private integration marker, not an upstream tracking deep link.
      return /^#trawl-number=((?=[A-Z0-9]*\d)[A-Z0-9]{4,40})$/.exec(page.hash)?.[1] ?? null;
    },
    settled(data, number, state) {
      if (data?.status === 'PROCESSING' && data.tc === number && typeof data.hid === 'string' && data.hid) state.handle = data.hid;
      if (data?.status === 'CHLNG_REQ') return data.tc === number || Boolean(state.handle && data.hid === state.handle);
      if (data?.status === 'UNTRACEABLE') return data.tc === number;
      const found = data?.status === 'FOUND' && data.track?.tc === number
        && typeof data.hid === 'string' && data.hid && data.track.hid === data.hid;
      if (found && !data.inProgress && /^[A-Za-z0-9_-]{1,100}$/.test(data.hid)
        && !Array.isArray(data.track.events) && (data.track.firstEv || data.track.lastEv)) {
        // This is the normal results route emitted by Postal Ninja's own URL
        // builder. Its page requests full history using the verified handle.
        state.resultUrl = `https://postal.ninja/en/track#/${data.hid}`;
      }
      return found && !data.inProgress;
    },
    async prepare(page, number, budgetMs) {
      const deadline = Date.now() + Math.max(0, Math.min(budgetMs, 15_000));
      const timeout = () => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('Postal Ninja form preparation timed out');
        return left;
      };
      const form = page.frameLocator('iframe[title="Package tracking widget"]').locator('form.tracker');
      await form.locator('input[type="text"]').fill(number, { timeout: timeout() });
      const save = form.locator('input[type="checkbox"]');
      if (await save.count()) await save.uncheck({ timeout: timeout() });
      // Run the normal form handler, including its Turnstile execution and
      // request signing. Tokens stay inside this isolated browser context.
      const submitted = await form.locator('button[type="submit"]').evaluate((element, expected) => {
        if (element.form?.querySelector('input[type="text"]')?.value !== expected || element.disabled) return false;
        element.click();
        return true;
      }, number, { timeout: timeout() });
      if (!submitted) throw new Error('Postal Ninja form was not ready for submission');
    },
  },
  {
    // 17TRACK polls: keep reading until a completed reply names the number.
    api: 'https://t.17track.net/track/restapi',
    provider: '17TRACK',
    requestMethod: 'POST',
    lean: true,
    // The page asks for the number by itself once its application runs.
    readyOnRequest: true,
    number(page) {
      if (page.origin !== 'https://t.17track.net' || page.pathname !== '/en') return null;
      const number = new URLSearchParams(page.hash.slice(1)).get('nums');
      return number && /^[A-Z0-9]{5,40}$/.test(number) ? number : null;
    },
    requestMatches(request, number) {
      try {
        const body = request.postDataJSON();
        return Array.isArray(body?.data) && body.data.length === 1 && body.data[0]?.num === number;
      } catch { return false; }
    },
    postcodeSubmitted(request, target) {
      const postcode = new URLSearchParams(target.hash.slice(1)).get('trawl-postcode');
      try { return Boolean(postcode && request.postDataJSON().data[0]?.params_v2?.postal_code === postcode); }
      catch { return false; }
    },
    prepareFor(target) {
      const values = new URLSearchParams(target.hash.slice(1)).getAll('trawl-postcode');
      return values.length === 1 && /^[A-Z0-9][A-Z0-9 -]{0,13}[A-Z0-9]$/.test(values[0]);
    },
    async setup(page) {
      // The first-visit tour replaces the real result with a demo shipment.
      // Skip that optional presentation before the application mounts.
      await page.addInitScript(() => {
        if (location.origin === 'https://t.17track.net') localStorage.setItem('tourDone', JSON.stringify('true'));
      });
    },
    settled(data, number, state) {
      const shipment = data.shipments?.find(s => s.number === number && s.code !== 100);
      state.postcodeOffered = data.meta?.code === 200 && shipment?.code === 400 && shipment.shipment === null
        && Array.isArray(shipment.params_v2) && shipment.params_v2.some(p => p?.key === 'postal_code');
      return data.meta?.code !== 200 || data.shipments?.some(s => s.number === number && s.code !== 100);
    },
    async prepare(page, number, budgetMs, { state, target, settle, restart }) {
      const deadline = Date.now() + Math.max(0, budgetMs);
      const timeout = () => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('17TRACK postcode submission timed out');
        return left;
      };
      await settle(timeout());
      if (!state.postcodeOffered || state.postcodeAttempted) return;
      state.postcodeAttempted = true;
      try {
        // Use the website's form handler so its fingerprint, request signing,
        // detected carriers and subsequent polling all carry the same input.
        await page.getByText(number, { exact: true }).first().waitFor({ state: 'visible', timeout: timeout() });
        await page.getByText('reference', { exact: true }).click({ timeout: timeout() });
        const dialog = page.getByRole('dialog');
        await dialog.locator('input[name="postal_code"]').fill(new URLSearchParams(target.hash.slice(1)).get('trawl-postcode'), { timeout: timeout() });
        restart();
        await dialog.locator('button[type="submit"]').click({ timeout: timeout() });
      } catch { throw new Error('17TRACK postcode form could not complete'); }
    },
  },
  {
    // Akamai accepts UPS tracking only from the session the page established,
    // which is why replies are read here and never replayed.
    api: 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US',
    provider: 'UPS',
    requestMethod: 'POST',
    keepLatestCaptures: true,
    number(page) {
      if (page.origin !== 'https://www.ups.com' || page.pathname !== '/track') return null;
      const number = (page.searchParams.get('tracknum') ?? '').toUpperCase();
      return /^1Z[A-Z0-9]{16}$/.test(number) ? number : null;
    },
    requestMatches(request, number) {
      try {
        const body = request.postDataJSON();
        const values = body?.TrackingNumber;
        return Array.isArray(values) && values.length === 1 && typeof values[0] === 'string'
          && /^1Z[A-Z0-9]{16}$/i.test(values[0]) && values[0].toUpperCase() === number;
      } catch { return false; }
    },
    settled(data, number) {
      const details = Array.isArray(data.trackDetails) ? data.trackDetails : [];
      return String(data.statusCode) !== '200' || details.length === 0
        || details.some(d => String(d?.trackingNumber ?? d?.requestedTrackingNumber ?? '').toUpperCase() === number);
    },
  },
  {
    // MySpeedy's tracker passes its Turnstile check, then asks for the number
    // in its route once, with the check's token. A number it does not know
    // gets its 404 page and a refused token gets 406; both are kept.
    api: 'https://myspeedy.speedy.bg/rest/public/track',
    provider: 'Speedy',
    requestMethod: 'GET',
    allowTextResponse: true,
    readStatuses: [404, 406],
    readyOnRequest: true,
    // The page fills no token field, so TRAWL's solver would wait out its budget after the reply.
    endsSolver: true,
    apiForNumber(number) {
      return `${this.api}?id=${number}&language=en&mobile=N`;
    },
    number(page) {
      if (page.origin !== 'https://myspeedy.speedy.bg' || page.search !== '?language=en' || page.hash) return null;
      return /^\/pub\/tracking\/(\d{11})$/.exec(page.pathname)?.[1] ?? null;
    },
    // One request, one final reply. The adapter binds the barcode it names.
    settled() { return true; },
  },
  {
    // MyDPD, DPD Romania's copy of MySpeedy, behaves the same: one request for
    // the waybill in its route, with the Turnstile token, its 404 page for a
    // waybill it does not know and 406 for a refused token.
    api: 'https://mydpd.dpd.ro/rest/public/track',
    provider: 'DPD Romania',
    requestMethod: 'GET',
    allowTextResponse: true,
    readStatuses: [404, 406],
    readyOnRequest: true,
    endsSolver: true,
    apiForNumber(number) {
      return `${this.api}?id=${number}&language=en&mobile=N`;
    },
    number(page) {
      if (page.origin !== 'https://mydpd.dpd.ro' || page.search !== '?language=en' || page.hash) return null;
      return /^\/pub\/tracking\/(8\d{10})$/.exec(page.pathname)?.[1] ?? null;
    },
    settled() { return true; },
  },
  {
    // FedEx answers once. The edge accepts this call only from the session
    // the page established, which is why the reply is read here and never
    // replayed. The page redirects its canonical /fedextrack/ URL to the
    // /wtrk/track/ application, so both pathnames serve the same lookup.
    api: 'https://api.fedex.com/track/v2/shipments',
    number(page) {
      if (page.origin !== 'https://www.fedex.com') return null;
      if (page.pathname !== '/wtrk/track/' && page.pathname !== '/fedextrack/') return null;
      const number = (page.searchParams.get('trknbr') ?? '').toUpperCase();
      return /^(\d{12}|\d{15}|\d{20})$/.test(number) ? number : null;
    },
    settled(data) {
      // One POST, one final reply: any decoded envelope ends the wait. The
      // adapter binds the packages to the requested number itself.
      return !!data?.output;
    },
  },
  {
    // The hash route can start tracking with consent already recorded;
    // otherwise submit the form after any consent-triggered reload.
    api: 'https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/',
    perNumber: true,
    number(page) {
      if (page.origin !== 'https://www.royalmail.com' || page.pathname !== '/track-your-item') return null;
      const number = (/^#\/tracking-results\/([A-Z0-9]+)\/?$/.exec(page.hash)?.[1] ?? '');
      return /^[A-Z]{2}\d{9}GB$/.test(number) ? number : null;
    },
    settled(data, number, state, status) {
      // The page retries E0015 with a new CAPTCHA token when its existing API
      // session is rejected. Keep that first reply for diagnosis, but allow
      // one automatic refresh within the normal capture deadline.
      if (status === 401 && !state.challengeRefresh
        && Array.isArray(data?.errors)
        && data.errors.some(error => error?.errorCode === 'E0015' || error?.code === 'E0015')) {
        state.challengeRefresh = true;
        return false;
      }
      // Other replies are final; the adapter verifies the mailpiece identity.
      return !!data && typeof data === 'object';
    },
  },
];

const NETWORK_ERRORS = new Set([
  'NS_ERROR_NET_RESET', 'NS_ERROR_NET_TIMEOUT', 'NS_ERROR_UNKNOWN_HOST',
  'net::ERR_CONNECTION_RESET', 'net::ERR_HTTP2_PROTOCOL_ERROR', 'net::ERR_TIMED_OUT',
]);

export async function attachTrackingCapture(page, url, options) {
  const usps = attachUspsTrackingCapture(page, url, options);
  if (usps) return usps;
  const history = await attachRoyalMailHistoryCapture(page, url, options);
  if (history) return history;
  const target = new URL(url);
  const requested = options.captureResponses ?? [];
  const site = SITES.find(candidate => candidate.number(target)
    && (!candidate.checkApi || requested.includes(candidate.checkApi))
    && (candidate.queryNumber
      ? requested.includes(`${candidate.api}?trackingIds=${candidate.number(target)}`)
      : candidate.perNumber
      ? requested.includes(candidate.api + candidate.number(target))
      : requested.includes(candidate.api)));
  if (!site) return undefined;
  const number = site.number(target);
  const state = {};
  if (site.setup && (!site.prepareFor || site.prepareFor(target))) await site.setup(page, number, state, options, target);
  // TRAWL's outbound policy is already routed on this page and still sees what passes here.
  if (site.lean) await page.route('**/*', route => unreadByLookup(route.request()) ? route.abort('blockedbyclient') : route.fallback());
  const api = site.apiForNumber ? site.apiForNumber(number)
    : site.api + (site.queryNumber ? `?trackingIds=${number}` : site.perNumber ? number : '');
  if (site.perNumber) {
    await page.context().addCookies(Object.entries(ROYAL_MAIL_OPT_OUT).map(([name, value]) => ({
      name, value, domain: '.royalmail.com', path: '/', secure: true, sameSite: 'Lax',
    })));
  }
  const entries = [];
  let terminal = false;
  let trackingRequested = false;
  let networkError;
  let accepting = true;
  let count = 0;
  let bodyReads = 0;
  let bytes = 0;
  let finish;
  const replied = new AbortController();
  const restart = () => {
    terminal = false;
    return new Promise(resolve => { finish = () => { terminal = true; replied.abort(); resolve(); }; });
  };
  let ready = restart();
  const settle = async budgetMs => {
    let timer;
    try {
      await Promise.race([ready, new Promise(resolve => {
        timer = setTimeout(resolve, Math.max(0, Math.min(budgetMs, options.settleTimeout ?? 15_000, 30_000)));
      })]);
    } finally { clearTimeout(timer); }
  };
  const observesRequests = site.perNumber || site.queryNumber || site.requestMethod;
  const matchesRequest = request => accepting && request.url() === api
    && request.method() === (site.requestMethod ?? 'GET')
    && (!site.requestMatches || site.requestMatches(request, number, target));
  let begin;
  const begun = new Promise(resolve => { begin = resolve; });
  const onRequest = request => { if (matchesRequest(request)) { trackingRequested = true; begin(); } };
  const onRequestFailed = request => {
    if (!matchesRequest(request)) return;
    const code = request.failure()?.errorText;
    networkError = NETWORK_ERRORS.has(code) ? code : 'network failure';
    finish();
  };
  const onResponse = async response => {
    if (!accepting || (response.url() !== api && response.url() !== site.checkApi)
      || (site.requestMethod && !matchesRequest(response.request()))
      || (site.checkApi && response.request().method() !== 'POST')
      || ((site.perNumber || site.queryNumber) && response.request().method() !== 'GET')) return;
    if (!site.keepLatestCaptures && ++count > 20) return;
    // A later matching response can recover a failed UPS request. Until then,
    // drain must not let an older successful response conceal that failure.
    if (site.keepLatestCaptures) networkError = undefined;
    const headers = response.headers();
    const entry = { url: response.url(), status: response.status(), body: null,
      headers: headers['retry-after'] ? { 'retry-after': headers['retry-after'].slice(0, 100) } : {},
      truncated: false, base64Encoded: false };
    if (site.postcodeSubmitted?.(response.request(), target)) entry.postcodeSubmitted = true;
    if (site.phoneDigitsSubmitted?.(response.request(), target)) entry.phoneDigitsSubmitted = true;
    entries.push(entry);
    // UPS retries can arrive after the old capture limit. Keep their arrival
    // order and latest metadata, including refusals whose bodies are private.
    if (site.keepLatestCaptures && entries.length > 20) entries.shift();
    if (entry.status !== 200 && !site.perNumber && !site.readStatuses?.includes(entry.status)) {
      if (!site.protectionRetry || ![401, 403].includes(entry.status)) finish();
      return;
    }
    const type = headers['content-type'] ?? '';
    const length = headers['content-length'] === undefined ? 0 : Number(headers['content-length']);
    // The browser already decoded this response for the site. Do not implement
    // our own decompressor, fetch again or transfer the session to Node.
    if ((!type.includes('application/json') && !site.allowTextResponse) || !Number.isSafeInteger(length)
      || length < 0 || length > 2_000_000 || bytes >= 4_000_000) {
      entry.error = 'unsupported or oversized tracking response'; finish(); return;
    }
    // Rolling metadata must not create unbounded body reads during a burst.
    // An unreadable latest 200 stays explicit; later HTTP refusals still win.
    if (site.keepLatestCaptures && bodyReads >= 20) {
      entry.error = 'tracking response extraction limit exceeded'; finish(); return;
    }
    try {
      if (site.keepLatestCaptures) bodyReads += 1;
      const body = await response.body();
      if (!accepting) return;
      bytes += body.length;
      if (body.length > 2_000_000 || bytes > 4_000_000) {
        entry.truncated = true; entry.error = 'tracking response budget exceeded'; finish(); return;
      }
      entry.body = body.toString('utf8');
      if (site.allowTextResponse && /^\s*</.test(entry.body)) { finish(); return; }
      const data = JSON.parse(entry.body);
      if (site.sanitize) { site.sanitize(data); entry.body = JSON.stringify(data); }
      // Preserve intermediate replies for diagnosis, but let the website carry
      // on until it holds a final reply for exactly the requested number.
      if (site.settled(data, number, state, entry.status)) finish();
    } catch {
      entry.error = 'tracking response could not be read';
      if (site.requestMethod) finish();
    }
  };
  page.on('response', onResponse);
  if (observesRequests) {
    page.on('request', onRequest);
    page.on('requestfailed', onRequestFailed);
  }
  if (site.ready || site.readyOnRequest) {
    let pageReady;
    // A page that never becomes usable leaves TRAWL's own waits in charge.
    readyPages.set(page, () => pageReady ??= site.ready
      ? site.ready(page).then(() => {}, () => new Promise(() => {})) : Promise.race([begun, ready]));
  }
  return {
    // Called by both TRAWL browser tiers after navigation and before solving.
    ...(site.prepare && (!site.prepareFor || site.prepareFor(target)) ? { async prepare(budgetMs) {
      const deadline = Date.now() + Math.max(0, budgetMs);
      await site.prepare(page, number, Math.max(0, deadline - Date.now()), { state, target, settle,
        restart: () => { ready = restart(); }, hasTrackingRequest: () => trackingRequested, finish,
        refuse({ status, retryAfter }) {
          if (entries.length >= 20) entries.shift();
          entries.push({ url: api, status, body: null, headers: retryAfter ? { 'retry-after': String(retryAfter).slice(0, 100) } : {},
            truncated: false, base64Encoded: false, error: 'verification refused' });
          finish();
        } });
      if (site.settleAfterPrepare === false) return;
      await settle(deadline - Date.now());
      if (!state.resultUrl || deadline - Date.now() < 1000) return;
      // Reuse this browser context: the main form has a separate verification
      // gate, but an established parcel's normal results page loads its full
      // history directly. Reset settlement so the compact reply cannot end
      // the new capture phase before that history arrives.
      ready = restart();
      await page.goto(state.resultUrl, {
        waitUntil: 'domcontentloaded', timeout: Math.min(15_000, deadline - Date.now()),
      });
    } } : {}),
    ...(site.perNumber ? { async prepare(budgetMs) {
      const deadline = Date.now() + Math.max(0, Math.min(budgetMs, 15_000));
      const timeout = () => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('Royal Mail form preparation timed out');
        return left;
      };
      const awaitReply = async () => {
        let timer;
        try { await Promise.race([ready, new Promise(resolve => {
          timer = setTimeout(resolve, Math.min(timeout(), 5_000));
        })]); } finally { clearTimeout(timer); }
      };
      // With opt-out preferences already present, the hash route can start
      // the lookup itself. Avoid submitting a second challenge/request.
      if (trackingRequested) { await awaitReply(); return; }
      const input = page.locator('#barcode-input');
      await input.waitFor({ state: 'visible', timeout: timeout() });
      // TrustArc can arrive after the app mounts. Dismiss optional cookies
      // before clicking, and handle a banner that appears during that click.
      const decline = page.getByText('Decline all', { exact: true });
      await decline.waitFor({ state: 'visible', timeout: Math.min(timeout(), 3_000) }).catch(() => {});
      if (await decline.isVisible()) {
        // TrustArc can reload the document after consent changes. Typing
        // before that reload finishes fills the outgoing form, while submit
        // resolves against a new, empty form and never triggers hCaptcha.
        const reloaded = page.waitForEvent('domcontentloaded', {
          timeout: Math.min(timeout(), 3_000),
        }).catch(() => {});
        await decline.evaluate(element => element.click());
        await reloaded;
        await input.waitFor({ state: 'visible', timeout: timeout() });
      }
      if (trackingRequested) { await awaitReply(); return; }
      // Native key events update React's controlled state even after the
      // hash route prefilled it. A DOM-only fill can leave stale form state.
      await input.press('ControlOrMeta+A', { timeout: timeout() });
      await input.press('Backspace', { timeout: timeout() });
      await input.pressSequentially(number, { timeout: timeout(), delay: 30 });
      if (await input.inputValue() !== number) throw new Error('Royal Mail input was reset before submission');
      // Camoufox's humanized mouse action can stall after reaching the button.
      // Invoke the page's normal click handler; it still runs its validation
      // and hCaptcha callback before making any tracking request.
      const submit = page.locator('#submit:not(:disabled)');
      await submit.waitFor({ state: 'visible', timeout: timeout() });
      if (trackingRequested) { await awaitReply(); return; }
      const submitted = await submit.evaluate((element, expected) => {
        // Check and click in one document: a late reload must not turn a
        // locally validated number into an empty submission.
        if (element.ownerDocument.querySelector('#barcode-input')?.value !== expected) return false;
        element.click();
        return true;
      }, number);
      if (!submitted) throw new Error('Royal Mail input was reset before submission');
      // Invisible hCaptcha commonly auto-passes after submit. Its callback
      // sends the API request and resets the widget; do not click it again.
      await awaitReply();
    } } : {}),
    // TRAWL's Turnstile solver waits for a token field some pages never fill;
    // their final reply already says the check passed.
    ...(site.endsSolver ? { solverSignal: signal => AbortSignal.any([signal, replied.signal]) } : {}),
    hasResponse() { return Boolean(((site.checkApi || site.queryNumber || site.requestMethod) && terminal) || (site.perNumber && entries.some(entry => entry.body !== null || entry.status !== 200))); },
    // Royal Mail can use an existing API session or a fresh CAPTCHA token.
    // Once the lookup starts, let its own refresh callback handle E0015.
    hasTrackingRequest() { return Boolean((site.checkApi && state.handle) || (observesRequests && trackingRequested)); },
    async settle(budgetMs) {
      if (site.postcodeSubmitted && site.prepareFor(target) && !state.postcodeAttempted) {
        const deadline = Date.now() + Math.max(0, budgetMs);
        await site.prepare(page, number, budgetMs, { state, target, settle, restart: () => { ready = restart(); } });
        await settle(Math.max(0, deadline - Date.now()));
      } else if (site.unlock) {
        await site.unlock(page, number, budgetMs, { state, target, settle, restart: () => { ready = restart(); }, finish: () => finish() });
      } else await settle(budgetMs);
    },
    async drain() {
      site.cleanup?.(state);
      accepting = false;
      readyPages.delete(page);
      page.off('response', onResponse);
      if (observesRequests) {
        page.off('request', onRequest);
        page.off('requestfailed', onRequestFailed);
      }
      // A loaded app shell is not a successful tracking session. Let the
      // orchestrator invalidate cached cookies and try its fresh browser tier.
      if (observesRequests && (entries.length === 0 || site.keepLatestCaptures && networkError)) {
        const provider = site.provider ?? (site.queryNumber ? 'Australia Post' : 'Royal Mail');
        if (networkError) throw new Error(`${provider} tracking request failed: ${networkError}`);
        throw new Error(`${provider} produced no tracking response after submission`);
      }
      return { capturedResponses: entries.map(entry => ({ ...entry })) };
    },
  };
}
