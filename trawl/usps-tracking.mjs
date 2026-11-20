const ORIGIN = 'https://tools.usps.com';
const OUTAGE = 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm';

export function uspsCaptureNumber(raw, options = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const number = /^\/tracking\/(\d{20}|\d{22}|\d{26}|[A-Z]{2}\d{9}[A-Z]{2})$/.exec(url.pathname)?.[1];
  return url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash && number
    && options.contentWaitForSelector === '#trackingNum' && options.captureResponses?.length === 1
    && options.captureResponses[0] === raw ? number : null;
}

/** USPS's verification wrapper can hide the tracking request's outage redirect. */
export function attachUspsTrackingCapture(page, url, options) {
  const number = uspsCaptureNumber(url, options);
  if (!number) return undefined;
  const entries = [];
  let active = true, prepared, finish;
  const terminal = new Promise(resolve => { finish = resolve; });
  const received = response => {
    if (!active || entries.length >= 3 || response.url() !== url || response.status() !== 302) return;
    const request = response.request();
    if (request.method() !== 'GET' || !['document', 'xhr', 'fetch'].includes(request.resourceType())
      || response.headers().location !== OUTAGE) return;
    try { if (request.frame() !== page.mainFrame()) return; } catch { return; }
    entries.push({ url, status: 302, headers: { location: OUTAGE }, body: null, error: null,
      truncated: false, base64Encoded: false, trackingNumberSubmitted: number });
    finish();
  };
  page.on('response', received);
  const prepare = budgetMs => prepared ??= (async () => {
    if (!active || entries.length || budgetMs <= 0) return;
    // Keep the ordinary readiness bound. An explicit outage is terminal even
    // when its cross-origin redirect leaves the verification page blank.
    await Promise.race([terminal, page.waitForSelector('#trackingNum',
      { state: 'visible', timeout: Math.min(10_000, budgetMs) }).catch(() => {})]);
  })();
  return {
    prepare,
    settle: prepare,
    hasResponse: () => entries.length > 0,
    // prepare already performed the same bounded visibility wait.
    contentOptions: capture => prepared ? { ...capture, contentWaitForSelector: undefined } : capture,
    async drain() {
      active = false;
      finish();
      page.off('response', received);
      return { capturedResponses: entries };
    },
  };
}

/** Whether a tier's reply holds the bound tracking request's redirect to the outage page. */
export function uspsOutage(result) {
  return Array.isArray(result?.capturedResponses) && result.capturedResponses.some(response =>
    response?.status === 302 && response.headers?.location === OUTAGE && typeof response.url === 'string'
    && response.url.startsWith(`${ORIGIN}/tracking/`) && typeof response.trackingNumberSubmitted === 'string'
    && response.trackingNumberSubmitted !== '');
}

// A session that USPS sent to the outage page carries the cookies it flagged: replayed, it is
// sent there again. TRAWL keeps a replayed session that returned any page, so it would replay
// that one until it expired. A replay sent to the outage page drops the site's session instead,
// and a fresh browser sent there saves none.
const SESSION_PATCHES = [
  ['        if (t2.cookies && t2.cookies.length > 0) {',
    '        if (uspsOutage(t2)) await deps.invalidateSession(domain)\n        else if (t2.cookies && t2.cookies.length > 0) {'],
  ['        const cookies: Cookie[] = t3.cookies ?? []\n        if (cookies.length > 0 && !explicitProxy && !importedCookies) {',
    '        const cookies: Cookie[] = t3.cookies ?? []\n        if (cookies.length > 0 && !explicitProxy && !importedCookies && !uspsOutage(t3)) {'],
];

// USPS sends the first read of every browser session to the outage page, and keeps sending some
// sessions there; a session it has let through keeps loading tracking, minutes apart or back to
// back. So reads without a proxy of their own go one at a time through one of TRAWL's named
// sessions, which keeps its context and its browser. A new session gets a few reads, spaced out,
// before it is replaced; one USPS has let through is replaced once it is refused twice in a row.
const SESSION_PREFIX = 'usps-tracking-';
export const USPS_SESSION_SPACING_MS = 10_000;
export const USPS_SESSION_TRIAL_READS = 3;
export const USPS_SESSION_LOST_AFTER = 2;
export const USPS_SESSION_MAX_AGE_MS = 2 * 60 * 60_000;
// Below this a read would only be cut short: a turn or a spacing wait that leaves less is not taken.
const MIN_READ_MS = 8_000;
const reportSession = fields => console.warn(JSON.stringify({ level: 'warn', event: 'usps.session', ...fields }));

const statusOf = error => (typeof error?.statusCode === 'number' ? error.statusCode : undefined);

export class UspsSessions {
  #current;
  #turn = Promise.resolve();
  #serial = 0;

  constructor({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = reportSession,
    spacingMs = USPS_SESSION_SPACING_MS, trialReads = USPS_SESSION_TRIAL_READS, lostAfter = USPS_SESSION_LOST_AFTER,
    maxAgeMs = USPS_SESSION_MAX_AGE_MS, minReadMs = MIN_READ_MS } = {}) {
    Object.assign(this, { now, sleep, report, spacingMs, trialReads, lostAfter, maxAgeMs, minReadMs });
  }

  /** Whether a scrape request is an ordinary USPS tracking read the kept session serves. */
  routes(req, sessions) {
    return Boolean(sessions) && !req?.sessionId && req?.proxy === undefined && !req?.cookies?.length
      && (req.maxTier ?? 4) >= 3 && uspsCaptureNumber(req.url, req) !== null;
  }

  #report(fields) {
    try { this.report(fields); } catch { /* Diagnostics never change a read. */ }
  }

  async #end(sessions, session, reason) {
    if (this.#current !== session) return;
    this.#current = undefined;
    this.#report({ state: 'ended', reason, reads: session.reads, accepted: session.accepted,
      ageMs: Math.max(0, this.now() - session.created) });
    try { await sessions.destroy(session.id); } catch { /* Already gone, or its sweep removes it. */ }
  }

  async #session(sessions) {
    const current = this.#current;
    if (current) {
      const live = (await sessions.list()).some(entry => entry.id === current.id);
      if (!live) await this.#end(sessions, current, 'expired');
      else if (this.now() - current.created >= this.maxAgeMs) await this.#end(sessions, current, 'max_age');
    }
    if (!this.#current) {
      const id = `${SESSION_PREFIX}${++this.#serial}`;
      await sessions.create({ id });
      this.#current = { id, created: this.now(), reads: 0, refusals: 0, failures: 0, accepted: false, lastReadAt: undefined };
      this.#report({ state: 'created' });
    }
    return this.#current;
  }

  /** Reads `req` through the kept session; `scrape` runs one read of a named session. */
  async run(req, sessions, scrape) {
    const started = this.now();
    const total = req.maxTimeout ?? 60_000;
    const left = () => total - (this.now() - started);
    const previous = this.#turn;
    let release, ready = false;
    this.#turn = new Promise(resolve => { release = resolve; });
    try {
      let timer;
      ready = await Promise.race([previous.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(0, left() - this.minReadMs));
      })]);
      clearTimeout(timer);
      if (!ready) throw Object.assign(new Error('USPS browser session is busy'), { statusCode: 429 });
      let session;
      try { session = await this.#session(sessions); }
      catch (error) {
        // Without a session of its own, the read goes as before, in a fresh browser.
        if (statusOf(error) === 429 || statusOf(error) === 503) return await scrape({ ...req, maxTimeout: Math.max(1, Math.floor(left())) });
        throw error;
      }
      if (!session.accepted && session.lastReadAt !== undefined) {
        const wait = this.spacingMs - (this.now() - session.lastReadAt);
        if (wait > 0 && left() - wait >= this.minReadMs) await this.sleep(wait);
      }
      session.reads++;
      session.lastReadAt = this.now();
      let result;
      try { result = await scrape({ ...req, sessionId: session.id, maxTimeout: Math.max(1, Math.floor(left())) }); }
      catch (error) {
        session.failures++;
        if ([404, 410].includes(statusOf(error))) await this.#end(sessions, session, 'gone');
        else if (session.failures >= 2) await this.#end(sessions, session, 'failed');
        throw error;
      }
      session.failures = 0;
      if (uspsOutage(result)) {
        session.refusals++;
        if (session.accepted ? session.refusals >= this.lostAfter : session.reads >= this.trialReads) {
          await this.#end(sessions, session, session.accepted ? 'refused' : 'not_accepted');
        }
      } else if (/\bid=["']?trackingNum\b/.test(result?.html ?? '')) {
        if (!session.accepted) this.#report({ state: 'accepted', reads: session.reads, ageMs: Math.max(0, this.now() - session.created) });
        session.accepted = true;
        session.refusals = 0;
      } else if (!session.accepted && session.reads >= this.trialReads) {
        await this.#end(sessions, session, 'not_accepted');
      }
      return result;
    } finally {
      // A read that gave up waiting passes its turn on only once the read before it ends.
      if (ready) release();
      else void previous.then(release);
    }
  }
}

export const uspsSessions = new UspsSessions();

const SCRAPE_ENTRY = 'export async function scrape(\n  req: ScrapeRequest,\n  deps: OrchestratorDeps,\n'
  + '  runners: OrchestratorRunners = {},\n): Promise<ScrapeResult> {\n';

/** Sends TRAWL's USPS tracking reads through the kept session, and stops the build when its entry moved. */
export function keepUspsSession(source) {
  if (source.split(SCRAPE_ENTRY).length !== 2) throw new Error('TRAWL orchestrator changed: review the USPS kept session');
  return 'import { uspsSessions } from "./utils/usps-tracking.mjs"\n' + source.replace(SCRAPE_ENTRY, SCRAPE_ENTRY
    + '  if (uspsSessions.routes(req, deps.sessions)) return uspsSessions.run(req, deps.sessions!, (read) => scrape(read, deps, runners))\n');
}

/** Patches TRAWL's orchestrator, and stops the build when the code it changes has moved. */
export function forgetUspsOutageSessions(source) {
  return 'import { uspsOutage } from "./utils/usps-tracking.mjs"\n' + SESSION_PATCHES.reduce((code, [needle, text]) => {
    if (code.split(needle).length !== 2) throw new Error('TRAWL orchestrator changed: review the USPS outage session patch');
    return code.replace(needle, text);
  }, source);
}
