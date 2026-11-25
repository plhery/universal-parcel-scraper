import { lookup as dnsLookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';

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
// that one until it expired. A replay sent to the outage page drops that session instead, under
// the key it was cached under (a request's own proxy keeps its own), and a fresh browser sent
// there saves none.
const SESSION_PATCHES = [
  ['        if (t2.cookies && t2.cookies.length > 0) {\n          await deps.saveSession(cacheKey, {',
    '        if (uspsOutage(t2)) await deps.invalidateSession(cacheKey)\n'
      + '        else if (t2.cookies && t2.cookies.length > 0) {\n          await deps.saveSession(cacheKey, {'],
  ['        const cookies: Cookie[] = t3.cookies ?? []\n        if (cookies.length > 0 && cacheAllowed) {',
    '        const cookies: Cookie[] = t3.cookies ?? []\n        if (cookies.length > 0 && cacheAllowed && !uspsOutage(t3)) {'],
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
const TIMED_OUT = /\btime(?:d)?[ -]?out\b/i;

/**
 * What one trial read met: the tracking page (`loaded`), USPS's outage page, another page, an error,
 * or the read's own timeout. Each is logged, so sessions USPS did not accept can be told apart.
 */
export function uspsTrialOutcome(result, error) {
  if (error !== undefined) {
    const status = statusOf(error);
    return error?.name === 'TimeoutError' || status === 408 || status === 504 || TIMED_OUT.test(String(error?.message ?? ''))
      ? 'timeout' : 'error';
  }
  if (uspsOutage(result)) return 'outage';
  return TRACKING.test(result?.html ?? '') ? 'loaded' : 'other_page';
}
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

  /** Sessions USPS has let through and kept. */
  get readyCount() {
    return this.#ready.length;
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
      ageMs: Math.max(0, this.now() - session.created), ...(session.trials ? { trials: session.trials } : {}) });
    try { await this.#sessions.destroy(session.id); } catch { /* Already gone, or its sweep removes it. */ }
    this.#prepare();
  }

  /** Opens sessions in the background until enough are ready, unless USPS just refused several or no lookup came. */
  #prepare() {
    if (!this.#template || this.now() < this.#restUntil || this.now() - this.#lastLookupAt >= this.idleMs) return;
    while (this.#ready.length + this.#preparing < this.readySessions
      && this.#failedTrials + this.#preparing < this.trialsBeforeRest) {
      this.#preparing++;
      void this.#trial().catch(error => {
        // A session that could not be opened or read is a refusal of its own kind, logged with its status.
        this.#report({ state: 'trial_failed', error: error?.name ?? 'Error', ...(statusOf(error) ? { status: statusOf(error) } : {}) });
        return false;
      }).then(accepted => {
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
      accepted: false, busy: false, trials: {} };
    await sessions.create({ id: session.id });
    this.#report({ state: 'created' });
    for (let read = 0; read < this.trialReads && !session.accepted; read++) {
      if (read) await this.sleep(this.spacingMs);
      session.reads++;
      const started = this.now();
      let result, failure;
      try { result = await this.#scrape({ ...this.#template, sessionId: session.id, maxTimeout: TRIAL_READ_MS }); }
      catch (error) { failure = error ?? new Error('USPS trial read failed'); }
      const outcome = uspsTrialOutcome(result, failure);
      session.trials[outcome] = (session.trials[outcome] ?? 0) + 1;
      // The error's name and status only: its message can carry the tracking URL.
      this.#report({ state: 'trial_read', read: session.reads, outcome, ms: Math.max(0, this.now() - started),
        ...(failure ? { error: failure?.name ?? 'Error', ...(statusOf(failure) ? { status: statusOf(failure) } : {}) } : {}) });
      if (failure) {
        if ([404, 410].includes(statusOf(failure))) break;
        continue;
      }
      session.accepted = outcome === 'loaded';
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

// One per process, however the module is reached: the server's warm-up and the orchestrator share it.
export const uspsSessions = globalThis[Symbol.for('upc.uspsSessions')] ??= new UspsSessions();

// A new container prepares its sessions before it opens its port while the container it replaces still
// serves: a client that finds the new port closed connects to the old container under the same network
// alias, and the deploy stops the old one once the new one answers its health check. The port stays
// closed only while another container under that alias answers, so a restart or a reboot, with no other
// container, opens it at once. The warm-up reads a public sample's tracking page as a lookup would, and the
// port opens once the kept sessions are ready, when the other container stops answering, or after five
// minutes when USPS refuses new sessions for a while.
export const USPS_WARMUP_MS = 5 * 60_000;
const PEER_CHECK_MS = 5_000;
const PEER_TIMEOUT_MS = 2_000;
const reportWarmup = fields => console.warn(JSON.stringify({ level: 'warn', event: 'usps.warmup', ...fields }));

/** The warm-up's read of a tracking page, made the way the USPS adapter asks for one; null for another number. */
export function uspsWarmupRequest(number) {
  const url = `${ORIGIN}/tracking/${String(number ?? '').trim()}`;
  const req = { url, skipHttp: true, maxTier: 3, maxTimeout: 60_000, contentWaitForSelector: '#trackingNum',
    captureResponses: [url] };
  return uspsCaptureNumber(url, req) ? req : null;
}

/** Whether another container under the network name `host` answers its health check on `port`. */
export async function uspsWarmupPeerServing(host, port, { lookup = dnsLookup, interfaces = networkInterfaces,
  fetcher = fetch, timeoutMs = PEER_TIMEOUT_MS } = {}) {
  let addresses;
  try { addresses = await lookup(host, { all: true }); } catch { return false; }
  const own = new Set(Object.values(interfaces()).flat().map(entry => entry?.address));
  for (const { address, family } of addresses) {
    if (own.has(address)) continue;
    const origin = family === 6 ? `http://[${address}]:${port}` : `http://${address}:${port}`;
    try {
      const response = await fetcher(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      if (response.ok) return true;
    } catch { /* That address does not serve. */ }
  }
  return false;
}

/**
 * Starts preparing the kept sessions through `scrape`. Resolves at once when no other container serves under
 * `peerHost`, and otherwise once the sessions are ready, that container stops answering, or `limitMs` passed.
 */
export async function warmUspsSessions({ number, deps, scrape, peerHost, port, sessions = uspsSessions,
  peer = peerHost ? () => uspsWarmupPeerServing(peerHost, port) : async () => false, limitMs = USPS_WARMUP_MS,
  pollMs = 1_000, peerEveryMs = PEER_CHECK_MS, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  report = reportWarmup }) {
  const say = fields => { try { report(fields); } catch { /* Diagnostics never hold the port. */ } };
  const serving = async () => { try { return await peer(); } catch { return false; } };
  const started = now();
  const req = uspsWarmupRequest(number);
  if (!req || !sessions.routes(req, deps?.sessions)) {
    say({ state: 'skipped', reason: req ? 'no_sessions' : 'invalid_number' });
    return { held: false, ready: 0, ms: 0 };
  }
  const held = await serving();
  // The read itself waits briefly and usually ends unanswered: the sessions it starts are what count.
  void Promise.resolve().then(() => scrape(req, deps)).catch(() => {});
  if (!held) {
    say({ state: 'not_held', reason: 'no_peer' });
    return { held: false, ready: sessions.readyCount, ms: Math.max(0, now() - started) };
  }
  say({ state: 'started' });
  let state, checked = now();
  for (;;) {
    if (sessions.readyCount >= sessions.readySessions) { state = 'ready'; break; }
    if (now() - started >= limitMs) { state = 'gave_up'; break; }
    await sleep(pollMs);
    if (now() - checked >= peerEveryMs) {
      checked = now();
      if (!await serving()) { state = 'peer_gone'; break; }
    }
  }
  const ready = sessions.readyCount, ms = Math.max(0, now() - started);
  say({ state, ready, ms });
  return { held: true, ready, ms };
}

const API_LISTEN = 'const app = createApiApp().listen(PORT)\n';
const API_POOL = 'const poolReady = initPool()\n';

/** With USPS_WARMUP_NUMBER set, opens TRAWL's port after the warm-up; stops the build when the server's start moved. */
export function listenAfterUspsWarmup(source) {
  for (const needle of [API_LISTEN, API_POOL]) {
    if (source.split(needle).length !== 2) throw new Error('TRAWL server start changed: review the USPS warm-up');
  }
  return 'import { scrape as uspsWarmupScrape } from "@trawl/tiers"\n'
    + 'import { warmUspsSessions } from "../../../packages/tiers/src/utils/usps-tracking.mjs"\n' + source
    .replace(API_LISTEN, 'const app = createApiApp()\nconst uspsWarmupNumber = process.env.USPS_WARMUP_NUMBER?.trim()\n'
      + 'if (!uspsWarmupNumber) app.listen(PORT)\n')
    .replace(API_POOL, API_POOL + 'if (uspsWarmupNumber) void poolReady\n'
      + '  .then(() => warmUspsSessions({ number: uspsWarmupNumber, deps: getDeps(), scrape: uspsWarmupScrape,\n'
      + '    peerHost: process.env.USPS_WARMUP_PEER?.trim(), port: PORT }))\n'
      + '  .catch(() => {})\n  .finally(() => app.listen(PORT))\n');
}

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
