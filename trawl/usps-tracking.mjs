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
// back, until USPS turns it away again. So reads without a proxy of their own go through TRAWL's
// named sessions, which keep their context and their browser, and only through sessions USPS has
// already let through. Those are prepared in the background, away from any lookup: a new session
// reads the last requested tracking page a few times, spaced out, and is kept once tracking loads.
// Two are kept, so a lookup turned away by one is read again through the other.
const SESSION_PREFIX = 'usps-tracking-';
export const USPS_SESSION_SPACING_MS = 10_000;
export const USPS_SESSION_TRIAL_READS = 3;
export const USPS_SESSION_LOST_AFTER = 2;
export const USPS_SESSION_MAX_AGE_MS = 2 * 60 * 60_000;
export const USPS_READY_SESSIONS = 2;
// After this many sessions in a row that USPS let none through, no new one is tried for the rest,
// which doubles each time up to sixteen minutes until USPS lets one through: USPS turns nearly every
// session away for hours at a time, and reads it would refuse are not worth sending.
export const USPS_TRIALS_BEFORE_REST = 4;
export const USPS_REST_MS = 2 * 60_000;
const LONGEST_REST = 8;
// Without a lookup for this long, no session is prepared; TRAWL's idle sweep closes the kept ones.
export const USPS_IDLE_MS = 30 * 60_000;
// How long a lookup waits for a session being prepared before it gives up.
export const USPS_WAIT_FOR_SESSION_MS = 20_000;
const TRIAL_READ_MS = 30_000;
// Below this a read would only be cut short: a session that leaves less is not taken.
const MIN_READ_MS = 8_000;
const TRACKING = /\bid=["']?trackingNum\b/;
const reportSession = fields => console.warn(JSON.stringify({ level: 'warn', event: 'usps.session', ...fields }));

const statusOf = error => (typeof error?.statusCode === 'number' ? error.statusCode : undefined);
const unready = () => Object.assign(new Error('No USPS browser session is ready'), { statusCode: 503 });

export class UspsSessions {
  #ready = [];
  #preparing = 0;
  #failedTrials = 0;
  #restUntil = 0;
  #rests = 0;
  #lastLookupAt = 0;
  #serial = 0;
  #changed = new Set();
  #template; #sessions; #scrape;

  constructor({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = reportSession,
    spacingMs = USPS_SESSION_SPACING_MS, trialReads = USPS_SESSION_TRIAL_READS, lostAfter = USPS_SESSION_LOST_AFTER,
    maxAgeMs = USPS_SESSION_MAX_AGE_MS, readySessions = USPS_READY_SESSIONS, trialsBeforeRest = USPS_TRIALS_BEFORE_REST,
    restMs = USPS_REST_MS, idleMs = USPS_IDLE_MS, waitMs = USPS_WAIT_FOR_SESSION_MS, minReadMs = MIN_READ_MS } = {}) {
    Object.assign(this, { now, sleep, report, spacingMs, trialReads, lostAfter, maxAgeMs, readySessions, trialsBeforeRest,
      restMs, idleMs, waitMs, minReadMs });
  }

  /** Whether a scrape request is an ordinary USPS tracking read the kept sessions serve. */
  routes(req, sessions) {
    return Boolean(sessions) && !req?.sessionId && req?.proxy === undefined && !req?.cookies?.length
      && (req.maxTier ?? 4) >= 3 && uspsCaptureNumber(req.url, req) !== null;
  }

  #report(fields) {
    try { this.report(fields); } catch { /* Diagnostics never change a read. */ }
  }

  #notify() {
    for (const wake of [...this.#changed]) wake();
  }

  async #end(session, reason) {
    const kept = this.#ready.indexOf(session);
    if (kept >= 0) this.#ready.splice(kept, 1);
    else if (session.accepted) return;
    this.#report({ state: 'ended', reason, reads: session.reads, accepted: session.accepted,
      ageMs: Math.max(0, this.now() - session.created) });
    try { await this.#sessions.destroy(session.id); } catch { /* Already gone, or its sweep removes it. */ }
    this.#prepare();
  }

  /** Opens sessions in the background until enough are ready, unless USPS just refused several or no lookup came. */
  #prepare() {
    if (!this.#template || this.now() < this.#restUntil || this.now() - this.#lastLookupAt >= this.idleMs) return;
    while (this.#ready.length + this.#preparing < this.readySessions
      && this.#failedTrials + this.#preparing < this.trialsBeforeRest) {
      this.#preparing++;
      void this.#trial().catch(() => false).then(accepted => {
        this.#preparing--;
        if (accepted) this.#failedTrials = this.#rests = 0;
        else if (++this.#failedTrials >= this.trialsBeforeRest && this.#restUntil <= this.now()) {
          this.#failedTrials = 0;
          const rest = this.restMs * Math.min(LONGEST_REST, 2 ** this.#rests++);
          this.#restUntil = this.now() + rest;
          this.#report({ state: 'resting', ready: this.#ready.length, restMs: rest });
          void this.sleep(rest).then(() => this.#prepare());
        }
        this.#notify();
        this.#prepare();
      });
    }
  }

  /** One new session's spaced reads of the last requested page; whether USPS let it through. */
  async #trial() {
    const sessions = this.#sessions;
    const session = { id: `${SESSION_PREFIX}${++this.#serial}`, created: this.now(), reads: 0, refusals: 0, failures: 0,
      accepted: false, busy: false };
    await sessions.create({ id: session.id });
    this.#report({ state: 'created' });
    for (let read = 0; read < this.trialReads && !session.accepted; read++) {
      if (read) await this.sleep(this.spacingMs);
      session.reads++;
      let result;
      try { result = await this.#scrape({ ...this.#template, sessionId: session.id, maxTimeout: TRIAL_READ_MS }); }
      catch (error) {
        if ([404, 410].includes(statusOf(error))) break;
        continue;
      }
      session.accepted = !uspsOutage(result) && TRACKING.test(result?.html ?? '');
    }
    if (!session.accepted) {
      await this.#end(session, 'not_accepted');
      return false;
    }
    this.#report({ state: 'accepted', reads: session.reads, ageMs: Math.max(0, this.now() - session.created) });
    this.#ready.push(session);
    return true;
  }

  /** A ready session no read holds and this lookup has not tried, waiting up to `waitMs` for one. */
  async #take(tried, waitMs) {
    const deadline = this.now() + waitMs;
    for (;;) {
      const live = new Set((await this.#sessions.list()).map(entry => entry.id));
      for (const session of [...this.#ready]) {
        if (session.busy) continue;
        if (!live.has(session.id)) await this.#end(session, 'expired');
        else if (this.now() - session.created >= this.maxAgeMs) await this.#end(session, 'max_age');
      }
      this.#prepare();
      const free = this.#ready.find(session => !session.busy && !tried.has(session));
      // Taken before the caller resumes: two lookups waiting together never get the same session.
      if (free) { free.busy = true; return free; }
      const waitable = this.#preparing > 0 || this.#ready.some(session => session.busy && !tried.has(session));
      const remaining = deadline - this.now();
      if (!waitable || remaining <= 0) return undefined;
      let wake;
      const changed = new Promise(resolve => { wake = resolve; });
      this.#changed.add(wake);
      let timer;
      await Promise.race([changed, new Promise(resolve => { timer = setTimeout(resolve, remaining); })]);
      clearTimeout(timer);
      this.#changed.delete(wake);
    }
  }

  /** Reads `req` through a session USPS has let through; `scrape` runs one read of a named session. */
  async run(req, sessions, scrape) {
    const started = this.now();
    const total = req.maxTimeout ?? 60_000;
    const left = () => total - (this.now() - started);
    this.#lastLookupAt = started;
    this.#template = { ...req };
    this.#sessions = sessions;
    this.#scrape = scrape;
    const tried = new Set();
    let refused;
    for (;;) {
      // A lookup one session turned away is read once more, through the other when it is free.
      const session = await this.#take(tried, refused ? 0 : Math.min(this.waitMs, left() - this.minReadMs));
      if (session && left() < this.minReadMs) { session.busy = false; this.#notify(); }
      if (!session || left() < this.minReadMs) {
        if (refused) return refused;
        throw unready();
      }
      tried.add(session);
      session.reads++;
      let result;
      try { result = await scrape({ ...req, sessionId: session.id, maxTimeout: Math.max(1, Math.floor(left())) }); }
      catch (error) {
        session.busy = false;
        if ([404, 410].includes(statusOf(error))) await this.#end(session, 'gone');
        else if (++session.failures >= 2) await this.#end(session, 'failed');
        this.#notify();
        throw error;
      }
      session.busy = false;
      session.failures = 0;
      if (!uspsOutage(result)) {
        if (TRACKING.test(result?.html ?? '')) session.refusals = 0;
        this.#notify();
        return result;
      }
      if (++session.refusals >= this.lostAfter) await this.#end(session, 'refused');
      this.#notify();
      refused = result;
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
