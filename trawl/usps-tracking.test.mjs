import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachUspsTrackingCapture, forgetUspsOutageSessions, keepUspsSession, listenAfterUspsWarmup, plainUspsBrowsers, USPS_IDLE_MS, USPS_PROXY_EXIT, USPS_PROXY_EXITS, UspsExits, USPS_SESSION_MAX_AGE_MS, USPS_WARMUP_MS, UspsPlainBrowsers, UspsSessions, uspsCaptureNumber, uspsOutage, uspsSessions, uspsUnready, uspsWarmupRequest, warmUspsSessions } from './usps-tracking.mjs';

const NUMBER = '9400111899223397910421';
const URL = `https://tools.usps.com/tracking/${NUMBER}`;
const OUTAGE = 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm';
const OPTIONS = { contentWaitForSelector: '#trackingNum', captureResponses: [URL] };
function harness() {
  const page = new EventEmitter();
  const frame = {};
  let ready;
  const waits = [];
  page.mainFrame = () => frame;
  page.waitForSelector = (selector, options) => {
    waits.push({ selector, ...options });
    return new Promise(resolve => { ready = resolve; });
  };
  const capture = attachUspsTrackingCapture(page, URL, OPTIONS);
  const respond = (overrides = {}) => page.emit('response', {
    url: () => overrides.url ?? URL, status: () => overrides.status ?? 302,
    headers: () => ({ location: overrides.location ?? OUTAGE, 'set-cookie': 'discard', other: 'discard' }),
    request: () => ({ method: () => overrides.method ?? 'GET', resourceType: () => overrides.type ?? 'xhr',
      frame: () => overrides.frame ?? frame }),
  });
  return { page, capture, respond, waits, ready: () => ready?.() };
}

test('only the opted-in exact USPS tracking capture is handled', () => {
  assert.equal(uspsCaptureNumber(URL, OPTIONS), NUMBER);
  for (const url of [URL + '?x=1', URL + '#x', URL.replace('https:', 'http:'),
    URL.replace('tools.usps.com', 'tools.usps.com.example'), URL.replace('tools.', 'user@tools.'),
    URL.replace(NUMBER, '1')]) assert.equal(uspsCaptureNumber(url, { ...OPTIONS, captureResponses: [url] }), null);
  for (const options of [{}, { ...OPTIONS, captureResponses: [] }, { ...OPTIONS, captureResponses: [URL, OUTAGE] },
    { ...OPTIONS, contentWaitForSelector: 'body' }]) assert.equal(uspsCaptureNumber(URL, options), null);
});

test('only an exact bound redirect ends readiness, and its safe projection is bounded', async () => {
  const h = harness();
  const waiting = h.capture.prepare(20_000);
  for (const overrides of [{ url: URL + '1' }, { status: 200 }, { method: 'POST' }, { type: 'image' },
    { frame: {} }, { location: OUTAGE + '?token=secret' }, { location: OUTAGE.replace('www.usps.com', 'example.com') }]) {
    h.respond(overrides);
    assert.equal(h.capture.hasResponse(), false);
  }
  h.respond();
  await waiting;
  for (let i = 0; i < 10; i++) h.respond();
  const options = h.capture.contentOptions(OPTIONS);
  assert.equal(options.contentWaitForSelector, undefined);
  assert.equal(OPTIONS.contentWaitForSelector, '#trackingNum');
  const result = await h.capture.drain();
  assert.equal(result.capturedResponses.length, 3);
  assert.deepEqual(result.capturedResponses[0], { url: URL, status: 302, headers: { location: OUTAGE },
    body: null, error: null, truncated: false, base64Encoded: false, trackingNumberSubmitted: NUMBER });
  assert.equal(h.page.listenerCount('response'), 0);
});

test('ordinary tracking uses one readiness wait and retains no page or session data', async () => {
  const h = harness();
  const waiting = h.capture.prepare(4000);
  h.respond({ status: 200 });
  h.ready();
  await waiting;
  await h.capture.settle(1000);
  assert.deepEqual(h.waits, [{ selector: '#trackingNum', state: 'visible', timeout: 4000 }]);
  assert.equal(h.capture.hasResponse(), false);
  assert.equal(h.capture.contentOptions(OPTIONS).contentWaitForSelector, undefined);
  assert.deepEqual(await h.capture.drain(), { capturedResponses: [] });
});

test('deadline cleanup stops observation and resolves an outstanding prepare', async () => {
  const h = harness();
  const waiting = h.capture.prepare(60_000);
  assert.equal(h.waits[0].timeout, 10_000);
  await h.capture.drain();
  await waiting;
  h.respond();
  assert.equal(h.capture.hasResponse(), false);
});

test('only the bound tracking request\'s outage redirect marks a reply as sent to the outage page', () => {
  const redirect = { url: URL, status: 302, headers: { location: OUTAGE }, trackingNumberSubmitted: NUMBER };
  assert.equal(uspsOutage({ capturedResponses: [redirect] }), true);
  for (const response of [{ ...redirect, status: 200 }, { ...redirect, headers: { location: OUTAGE + '?x=1' } },
    { ...redirect, trackingNumberSubmitted: undefined }, { ...redirect, trackingNumberSubmitted: '' },
    { ...redirect, url: 'https://example.com/tracking/' + NUMBER }, null]) {
    assert.equal(uspsOutage({ capturedResponses: [response] }), false);
  }
  for (const result of [undefined, {}, { capturedResponses: [] }, { capturedResponses: 'x' }]) assert.equal(uspsOutage(result), false);
});

test('a USPS session sent to the outage page is dropped after a replay and never saved from a fresh browser', () => {
  const source = [
    'import { x } from "./x"',
    '      if (hasUsablePayload(t2) && !crossed2) {',
    '        if (t2.cookies && t2.cookies.length > 0) {',
    '          await deps.saveSession(cacheKey, {',
    '          })',
    '        }',
    '      }',
    '      if (hasUsablePayload(t3) && !crossed3) {',
    '        const cookies: Cookie[] = t3.cookies ?? []',
    '        if (cookies.length > 0 && cacheAllowed) {',
    '          await deps.saveSession(cacheKey, {})',
    '        }',
    '      }',
    '      if (hasUsablePayload(t4) && !crossed4) {',
    '      const cookies: Cookie[] = t4.cookies ?? []',
    '      if (cookies.length > 0 && cacheAllowed) {',
  ].join('\n');
  const patched = forgetUspsOutageSessions(source);
  assert.match(patched, /^import \{ uspsOutage \} from "\.\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /if \(uspsOutage\(t2\)\) await deps\.invalidateSession\(cacheKey\)\n {8}else if \(t2\.cookies/);
  assert.match(patched, /cacheAllowed && !uspsOutage\(t3\)\) \{/);
  assert.equal(patched.split('uspsOutage(').length, 3);
  assert.throws(() => forgetUspsOutageSessions(source.replace('t2.cookies &&', 't2.cookies?.length &&')), /review the USPS outage session patch/);
  assert.throws(() => forgetUspsOutageSessions(source + '\n        if (t2.cookies && t2.cookies.length > 0) {\n          await deps.saveSession(cacheKey, {'), /review the USPS outage session patch/);
  // The replayed session is dropped under the key it was saved under.
  assert.throws(() => forgetUspsOutageSessions(source.replace('saveSession(cacheKey, {\n', 'saveSession(domain, {\n')), /review the USPS outage session patch/);
});

// Mocked clock and timers: `advance` lets the background preparation and the reads run for that long.
function keeper(t, { outcomes = {}, createStatus, options } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const events = [], reads = [], live = new Set();
  let active = 0, most = 0;
  const sessions = {
    created: [], destroyed: [],
    async list() { return [...live].map(id => ({ id })); },
    proxies: [],
    async create({ id, proxy }) {
      if (createStatus) throw Object.assign(new Error('x'), { statusCode: createStatus });
      this.created.push(id); this.proxies.push(proxy); live.add(id);
    },
    async destroy(id) { this.destroyed.push(id); live.delete(id); },
  };
  const keep = new (options?.exits ? UspsExits : UspsSessions)({ report: fields => events.push(fields), ...options });
  const scrape = async req => {
    reads.push({ id: req.sessionId, at: Date.now(), maxTimeout: req.maxTimeout, url: req.url, ...('proxy' in req ? { proxy: req.proxy } : {}) });
    most = Math.max(most, ++active);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    active--;
    const outcome = outcomes[req.sessionId.replace('usps-tracking-', '')]?.shift() ?? 'T';
    if (outcome instanceof Error) throw outcome;
    return outcome === 'r'
      ? { html: '<html></html>', capturedResponses: [{ url: URL, status: 302, headers: { location: OUTAGE }, trackingNumberSubmitted: NUMBER }] }
      : outcome === '?' ? { html: '<html></html>', capturedResponses: [] }
      : { html: `<input id="trackingNum" value="${NUMBER}">`, session: req.sessionId, capturedResponses: [] };
  };
  const advance = async ms => {
    const flush = async () => { for (let turn = 0; turn < 20; turn++) await new Promise(setImmediate); };
    await flush();
    const step = ms > 600_000 ? 60_000 : 500;
    for (let passed = 0; passed < ms; passed += step) {
      t.mock.timers.tick(step);
      await flush();
    }
  };
  const settled = promise => { const state = {}; promise.then(value => { state.value = value; }, error => { state.error = error; }); return state; };
  const read = (extra = {}) => settled(keep.run({ url: URL, ...OPTIONS, skipHttp: true, maxTier: 3, maxTimeout: 45_000, ...extra }, sessions, scrape));
  return { keep, sessions, scrape, read, reads, events, live, advance, most: () => most };
}
const states = events => events.filter(event => event.state !== 'trial_read').map(event => event.reason ?? event.state);
const of = (reads, n) => reads.filter(read => read.id === `usps-tracking-${n}`);

test('only an ordinary USPS tracking read without a proxy, cookies or session of its own uses the kept sessions', () => {
  const keep = new UspsSessions();
  const req = { url: URL, ...OPTIONS, maxTier: 3 };
  assert.equal(keep.routes(req, {}), true);
  assert.equal(keep.routes(req, undefined), false);
  for (const other of [{ sessionId: 'x' }, { proxy: 'http://proxy.example:8080' }, { proxy: null }, { cookies: [{ name: 'a' }] },
    { maxTier: 1 }, { url: 'https://tools.usps.com/go/TrackConfirmAction' }, { contentWaitForSelector: undefined }]) {
    assert.equal(keep.routes({ ...req, ...other }, {}), false, JSON.stringify(other));
  }
});

const PROXY = 'http://user:secret@proxy.example:8080';

test('a USPS read through a proxy has sessions of its own, up to two proxies, and others keep the pool', () => {
  const exits = new UspsExits();
  const req = { url: URL, ...OPTIONS, maxTier: 3 };
  assert.equal(exits.routes(req, {}), true);
  assert.equal(exits.routes({ ...req, proxy: PROXY }, {}), true);
  assert.equal(exits.routes({ ...req, proxy: PROXY }, undefined), false);
  for (const proxy of [null, '', '  ', 8080]) assert.equal(exits.routes({ ...req, proxy }, {}), false, JSON.stringify(proxy));
  for (const other of [{ sessionId: 'x' }, { cookies: [{ name: 'a' }] }, { maxTier: 1 }, { contentWaitForSelector: undefined }]) {
    assert.equal(exits.routes({ ...req, proxy: PROXY, ...other }, {}), false, JSON.stringify(other));
  }
  assert.equal(USPS_PROXY_EXITS, 2);
  assert.equal(exits.routes({ ...req, proxy: 'http://second.example:8080' }, {}), true);
  assert.equal(exits.routes({ ...req, proxy: 'http://third.example:8080' }, {}), false);
  assert.equal(exits.routes({ ...req, proxy: PROXY }, {}), true);
});

test('a proxy\'s sessions open through it, read without naming it, rest on their own and log no address', async t => {
  const k = keeper(t, { options: { exits: true }, outcomes: {
    1: ['r', 'r', 'r'], 2: ['r', 'r', 'r'], 3: ['r', 'r', 'r'], 4: ['r', 'r', 'r'], 'proxy1-1': ['r', 'T'],
    'proxy1-2': ['r', 'r', 'r'] } });
  // TRAWL's own address: four sessions refused, then a rest.
  const direct = k.read();
  await k.advance(60_000);
  assert.equal(direct.error.statusCode, 503);
  assert.equal(states(k.events).at(-1), 'resting');
  // A read through the proxy is not held by that rest: its own session is prepared through the proxy and read.
  const proxied = k.read({ proxy: PROXY });
  await k.advance(16_500);
  assert.equal(proxied.value.session, 'usps-tracking-proxy1-1');
  // A proxy is paid by the byte: its exit keeps one session.
  assert.deepEqual(k.sessions.created.filter(id => id.includes('proxy')), ['usps-tracking-proxy1-1']);
  assert.deepEqual(k.sessions.proxies.slice(4), [PROXY]);
  assert.deepEqual(k.sessions.proxies.slice(0, 4), [undefined, undefined, undefined, undefined]);
  assert.equal(k.reads.some(read => 'proxy' in read), false);
  const own = k.events.filter(event => event.route === 'proxy');
  assert.deepEqual(states(own), ['created', 'accepted']);
  assert.equal(k.events.filter(event => event.route === undefined).length > 0, true);
  assert.equal(JSON.stringify(k.events).includes('proxy.example'), false);
  // TRAWL's own address still rests: a read without a proxy is told at once that none is ready.
  const after = k.read();
  await k.advance(500);
  assert.equal(after.error.statusCode, 503);
});

test('a proxy\'s exit rests after two sessions USPS refused, and prepares none five minutes after the last lookup', async t => {
  assert.deepEqual(USPS_PROXY_EXIT, { readySessions: 1, trialsBeforeRest: 2, idleMs: 300_000 });
  const k = keeper(t, { options: { exits: true }, outcomes: { 'proxy1-1': ['r', 'r', 'r'], 'proxy1-2': ['r', 'r', 'r'] } });
  const refused = k.read({ proxy: PROXY });
  await k.advance(60_000);
  assert.equal(refused.error.statusCode, 503);
  assert.deepEqual(states(k.events), ['created', 'not_accepted', 'created', 'not_accepted', 'resting']);
  assert.equal(k.events.at(-1).restMs, 120_000);
  // During the rest a read is told at once; after it a session is prepared again, and once kept it is the only one.
  const resting = k.read({ proxy: PROXY });
  await k.advance(500);
  assert.equal(resting.error.statusCode, 503);
  await k.advance(120_000);
  const later = k.read({ proxy: PROXY });
  await k.advance(30_000);
  assert.equal(later.value.session, 'usps-tracking-proxy1-3');
  // Without a lookup for five minutes, a session that ends is not replaced.
  await k.advance(USPS_SESSION_MAX_AGE_MS);
  assert.equal(k.sessions.created.length, 3);
});

test('sessions are prepared in the background with spaced reads, and a lookup only reads one USPS let through', async t => {
  const k = keeper(t, { outcomes: { 1: ['r', 'T'], 2: ['r', 'r', 'r'] } });
  const first = k.read();
  await k.advance(13_500);
  assert.equal(first.value, undefined);
  assert.deepEqual(k.sessions.created, ['usps-tracking-1', 'usps-tracking-2']);
  await k.advance(3_000);
  // Trial reads at 0 and 12 s; the waiting lookup follows on the session that loaded tracking.
  assert.deepEqual(of(k.reads, 1).map(read => read.at), [0, 12_000, 14_000]);
  assert.equal(first.value.session, 'usps-tracking-1');
  assert.ok(of(k.reads, 1)[2].maxTimeout <= 31_000);
  await k.advance(30_000);
  // The session USPS kept refusing was closed after three reads, and another took its place.
  assert.equal(of(k.reads, 2).length, 3);
  assert.deepEqual(k.sessions.destroyed, ['usps-tracking-2']);
  assert.deepEqual([...k.live], ['usps-tracking-1', 'usps-tracking-3']);
  assert.deepEqual(states(k.events), ['created', 'created', 'accepted', 'not_accepted', 'created', 'accepted']);
  const later = k.read();
  await k.advance(2_000);
  assert.equal(later.value.session, 'usps-tracking-1');
  assert.equal(k.sessions.created.length, 3);
});

test('a lookup gives up when no session is ready in time, and at once while USPS refuses every new one', async t => {
  const refused = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, ['r', 'r', 'r']]));
  const k = keeper(t, { outcomes: refused });
  const first = k.read();
  await k.advance(19_500);
  assert.equal(first.error, undefined);
  await k.advance(1_000);
  assert.equal(first.error.statusCode, 503);
  assert.match(first.error.message, /No USPS browser session is ready/);
  await k.advance(40_000);
  // Four sessions refused in a row: nothing new is tried for two minutes, and a lookup is told at once.
  assert.equal(k.sessions.created.length, 4);
  assert.equal(states(k.events).at(-1), 'resting');
  const during = k.read();
  await k.advance(500);
  assert.equal(during.error.statusCode, 503);
  assert.equal(k.sessions.created.length, 4);
  await k.advance(120_000);
  assert.equal(k.sessions.created.length, 6);
  // Refused again, the rest doubles; a session USPS lets through ends it.
  k.read();
  await k.advance(60_000);
  assert.equal(k.sessions.created.length, 8);
  assert.deepEqual(k.events.filter(event => event.state === 'resting').map(event => event.restMs), [120_000, 240_000]);
  k.read();
  await k.advance(130_000);
  assert.equal(k.sessions.created.length, 8);
  k.read();
  await k.advance(130_000);
  assert.equal(k.sessions.created.length, 10);
  assert.equal(k.reads.every(read => read.id), true);
});

test('a lookup one session turns away is read again through the other, and a session refused twice is replaced', async t => {
  const k = keeper(t, { outcomes: { 1: ['T', 'T', 'r', 'r'] } });
  k.read();
  await k.advance(10_000);
  const turned = k.read();
  await k.advance(4_500);
  assert.equal(turned.value.session, 'usps-tracking-2');
  assert.deepEqual(k.reads.slice(-2).map(read => read.id), ['usps-tracking-1', 'usps-tracking-2']);
  assert.equal(k.live.has('usps-tracking-1'), true);
  const again = k.read();
  await k.advance(4_500);
  // Its second refusal in a row closes the session; the lookup still gets the other one's page.
  assert.equal(again.value.session, 'usps-tracking-2');
  assert.equal(k.live.has('usps-tracking-1'), false);
  assert.equal(states(k.events).includes('refused'), true);
  await k.advance(5_000);
  assert.equal(k.live.has('usps-tracking-3'), true);
});

test('with a single session ready, a lookup it turns away gets the redirect back', async t => {
  const k = keeper(t, { outcomes: { 1: ['T', 'T', 'r', 'T', 'r'] }, options: { readySessions: 1 } });
  k.read();
  await k.advance(5_000);
  const turned = k.read();
  await k.advance(2_500);
  assert.equal(uspsOutage(turned.value), true);
  // A page that loads between two refusals keeps the session.
  k.read();
  await k.advance(2_500);
  k.read();
  await k.advance(2_500);
  assert.deepEqual([...k.live], ['usps-tracking-1']);
});

test('each trial read logs what it met, and a session USPS did not accept sums them', async t => {
  const timeout = Object.assign(new Error(`Navigation to ${URL} timed out`), { name: 'TimeoutError' });
  const failed = Object.assign(new Error(`Upstream failed for ${URL}`), { statusCode: 502 });
  const k = keeper(t, { outcomes: { 1: ['r', '?', timeout], 2: [failed, 'T'] }, options: { readySessions: 1 } });
  k.read();
  await k.advance(120_000);
  const trials = k.events.filter(event => event.state === 'trial_read');
  assert.deepEqual(trials.map(({ read, outcome, error, status }) => ({ read, outcome, error, status })), [
    { read: 1, outcome: 'outage', error: undefined, status: undefined },
    { read: 2, outcome: 'other_page', error: undefined, status: undefined },
    { read: 3, outcome: 'timeout', error: 'TimeoutError', status: undefined },
    { read: 1, outcome: 'error', error: 'Error', status: 502 },
    { read: 2, outcome: 'loaded', error: undefined, status: undefined },
  ]);
  assert.equal(trials.every(event => event.ms >= 0), true);
  assert.deepEqual(k.events.find(event => event.reason === 'not_accepted').trials, { outage: 1, other_page: 1, timeout: 1 });
  // No logged field carries the tracking URL an error's message can hold.
  assert.equal(JSON.stringify(k.events).includes(NUMBER), false);
});

test('a session that cannot be opened logs why', async t => {
  const k = keeper(t, { createStatus: 503, options: { readySessions: 1 } });
  k.read();
  await k.advance(5_000);
  assert.deepEqual(k.events.find(event => event.state === 'trial_failed'), { state: 'trial_failed', error: 'Error', status: 503 });
});

test('an expired or aged session is replaced, and failed reads end one', async t => {
  const gone = Object.assign(new Error('gone'), { statusCode: 410 });
  const k = keeper(t, { outcomes: { 3: ['T', 'T', gone], 4: ['T', new Error('a'), new Error('b')] }, options: { readySessions: 1 } });
  k.read();
  await k.advance(5_000);
  k.live.delete('usps-tracking-1');
  const second = k.read();
  await k.advance(5_000);
  assert.equal(second.value.session, 'usps-tracking-2');
  assert.equal(states(k.events).includes('expired'), true);
  await k.advance(USPS_SESSION_MAX_AGE_MS);
  const third = k.read();
  await k.advance(5_000);
  assert.equal(third.value.session, 'usps-tracking-3');
  assert.equal(states(k.events).includes('max_age'), true);
  const fourth = k.read();
  await k.advance(2_500);
  assert.equal(fourth.error.statusCode, 410);
  assert.equal(states(k.events).at(-2), 'gone');
  await k.advance(3_000);
  for (const expected of [/a/, /b/]) {
    const failing = k.read();
    await k.advance(2_500);
    assert.match(failing.error.message, expected);
  }
  assert.equal(states(k.events).includes('failed'), true);
  assert.equal(k.live.has('usps-tracking-4'), false);
});

test('two lookups at once read through different sessions, and a third waits for one to be free', async t => {
  const k = keeper(t);
  k.read();
  await k.advance(5_000);
  const before = k.reads.length;
  const lookups = [k.read(), k.read(), k.read()];
  await k.advance(1_000);
  assert.deepEqual(k.reads.slice(before).map(read => read.id).sort(), ['usps-tracking-1', 'usps-tracking-2']);
  await k.advance(4_000);
  assert.equal(lookups.every(lookup => lookup.value), true);
  assert.equal(k.reads.length, before + 3);
  assert.equal(k.most(), 2);
});

test('no session is prepared when none can be opened, nor once lookups have stopped', async t => {
  const full = keeper(t, { createStatus: 429 });
  const refused = full.read();
  await full.advance(1_000);
  assert.equal(refused.error.statusCode, 503);
  assert.equal(full.reads.length, 0);
  t.mock.timers.reset();
  const k = keeper(t, { options: { readySessions: 1 } });
  k.read();
  await k.advance(5_000);
  await k.advance(USPS_IDLE_MS);
  k.live.clear();
  await k.advance(60_000);
  assert.equal(k.sessions.created.length, 1);
  const back = k.read();
  await k.advance(5_000);
  assert.equal(back.value.session, 'usps-tracking-2');
});

test('the orchestrator sends ordinary USPS reads through the kept session, and no session ready as HTTP 503', () => {
  const imports = 'import {\n  proxySanitizeHeaders,\n  RequestValidationError,\n} from "./utils/sanitize"\n';
  const entry = 'export async function scrape(\n  req: ScrapeRequest,\n  deps: OrchestratorDeps,\n'
    + '  runners: OrchestratorRunners = {},\n): Promise<ScrapeResult> {\n  const started = Date.now()\n';
  const patched = keepUspsSession(imports + entry);
  assert.match(patched, /^import \{ uspsSessions, uspsUnready \} from "\.\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /Promise<ScrapeResult> \{\n {2}if \(uspsSessions\.routes\(req, deps\.sessions\)\) return uspsSessions\.run\(req, deps\.sessions!, \(read\) => scrape\(read, deps, runners\)\)\n {4}\.catch\(\(error\) => \{ throw uspsUnready\(error\) \? new RequestValidationError\(error\.message, 503\) : error \}\)\n {2}const started/);
  assert.throws(() => keepUspsSession(imports + entry.replace('runners: OrchestratorRunners = {}', 'runners = {}')), /review the USPS kept session/);
  assert.throws(() => keepUspsSession(entry), /review the USPS kept session/);
});

test('no session ready is told apart from other failures', async () => {
  const sessions = new UspsSessions({ waitMs: 0 });
  const error = await sessions.run({ url: URL, skipHttp: true, maxTier: 3, maxTimeout: 30_000, ...OPTIONS },
    { create: async () => new Promise(() => {}), destroy: async () => {}, list: () => [] }, async () => ({})).catch(error => error);
  assert.equal(uspsUnready(error), true);
  for (const other of [new Error('No USPS browser session is ready'), Object.assign(new Error('Session busy'), { statusCode: 503 }), undefined]) {
    assert.equal(uspsUnready(other), false);
  }
});

test('USPS sessions acquire a plain browser of their own, and the rest the pool', () => {
  const source = 'import type { AcquireOptions } from "./orchestrator"\n  async use<T>(\n    id: string,\n    domain: string,\n'
    + '      const acquired = await budget.run<BrowserHandle>(() =>\n        this.deps\n          .acquireBrowser(domain, budget.remaining(), {\n'
    + '            signal: budget.signal,\n';
  const patched = plainUspsBrowsers(source);
  assert.match(patched, /^import \{ uspsPlainBrowsers \} from "\.\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /\(id\.startsWith\("usps-tracking-"\) \? uspsPlainBrowsers\.acquirer\(id\)\n {10}: \(d: string, b: number, o: AcquireOptions\) => this\.deps\.acquireBrowser\(d, b, o\)\)\(domain, budget\.remaining\(\), \{\n {12}signal/);
  assert.throws(() => plainUspsBrowsers(source.replace('this.deps\n          .acquireBrowser', 'this.deps.acquireBrowser')), /review the USPS plain browser/);
  assert.throws(() => plainUspsBrowsers(source.replace('    id: string,', '    sessionId: string,')), /review the USPS plain browser/);
});

function plainBrowser() {
  const browser = new EventEmitter();
  const open = new Set();
  Object.assign(browser, {
    closed: false,
    isConnected: () => !browser.closed,
    contexts: () => [...open],
    newContext: async () => {
      const context = { newPage: async () => ({ evaluate: async () => 'Mozilla/5.0 Camoufox' }), close: async () => { open.delete(context); } };
      open.add(context);
      return context;
    },
    close: async () => { browser.closed = true; browser.emit('disconnected'); },
  });
  return browser;
}

test('a USPS session keeps its plain browser until it has had no context for a minute', async () => {
  let now = 0;
  const launched = [];
  const plain = new UspsPlainBrowsers({ now: () => now, sweepMs: 3_600_000, launch: async timeoutMs => {
    const browser = plainBrowser();
    launched.push({ browser, timeoutMs });
    return browser;
  } });
  const first = await plain.acquirer('usps-tracking-1')('tools.usps.com', 30_000, {});
  assert.equal(first.fingerprint.userAgent, 'Mozilla/5.0 Camoufox');
  assert.equal(launched[0].timeoutMs, 30_000);
  assert.equal(launched[0].browser.contexts().length, 0, 'the user agent read closes its context');
  const context = await first.browser.newContext();
  assert.equal((await plain.acquire('usps-tracking-1', 30_000)).browser, first.browser);
  const second = await plain.acquire('usps-tracking-2', 1_000);
  assert.notEqual(second.browser, first.browser);
  assert.equal(launched[1].timeoutMs, 5_000);
  await second.browser.newContext();
  await context.close();
  plain.sweep();
  now += 59_000;
  plain.sweep();
  assert.equal(first.browser.closed, false);
  now += 1_000;
  plain.sweep();
  assert.equal(first.browser.closed, true);
  assert.equal(plain.size, 1);
  await second.browser.close();
  assert.equal(plain.size, 0, 'a disconnected browser is forgotten');
  const aborted = AbortSignal.abort();
  await assert.rejects(plain.acquire('usps-tracking-3', 30_000, aborted));
  const failing = new UspsPlainBrowsers({ launch: async () => { throw new Error('launch failed'); } });
  await assert.rejects(failing.acquire('usps-tracking-4', 30_000), /launch failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failing.size, 0);
});

test('the warm-up reads a tracking page the way the adapter does, and only for a USPS number', () => {
  const req = uspsWarmupRequest(` ${NUMBER} `);
  assert.deepEqual(req, { url: URL, skipHttp: true, maxTier: 3, maxTimeout: 60_000, contentWaitForSelector: '#trackingNum', captureResponses: [URL] });
  assert.equal(new UspsSessions().routes(req, {}), true);
  for (const number of ['', undefined, '1', `${NUMBER}?x=1`, `${NUMBER}/x`]) assert.equal(uspsWarmupRequest(number), null, String(number));
  assert.equal(globalThis[Symbol.for('upc.uspsSessions')], uspsSessions);
});

test('the warm-up ends once both sessions are ready, through the lookup path', async t => {
  const k = keeper(t, { outcomes: { 1: ['r', 'T'], 2: ['r', 'r', 'T'] } });
  const events = [];
  const scrapes = [];
  const warm = warmUspsSessions({ number: NUMBER, deps: { sessions: k.sessions }, sessions: k.keep, report: fields => events.push(fields),
    peer: async () => true, scrape: (req, deps) => { scrapes.push(req); return k.keep.run(req, deps.sessions, k.scrape); } });
  const done = {};
  warm.then(value => { done.value = value; });
  await k.advance(20_000);
  assert.equal(done.value, undefined);
  assert.deepEqual(scrapes.map(req => req.url), [URL]);
  await k.advance(10_000);
  assert.equal(k.keep.readyCount, 2);
  assert.equal(done.value.ready, 2);
  assert.equal(done.value.held, true);
  assert.ok(done.value.ms >= 24_000 && done.value.ms <= 28_000, String(done.value.ms));
  assert.deepEqual(events.map(event => event.state), ['started', 'ready']);
});

test('the warm-up gives up after its limit while USPS refuses every session', async t => {
  const refusals = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [n + 1, ['r', 'r', 'r']]));
  const k = keeper(t, { outcomes: refusals });
  const events = [];
  const done = {};
  let checks = 0;
  warmUspsSessions({ number: NUMBER, deps: { sessions: k.sessions }, sessions: k.keep, report: fields => events.push(fields),
    peer: async () => { checks++; return true; },
    scrape: (req, deps) => k.keep.run(req, deps.sessions, k.scrape) }).then(value => { done.value = value; });
  await k.advance(USPS_WARMUP_MS - 5_000);
  assert.equal(done.value, undefined);
  await k.advance(10_000);
  assert.equal(done.value.ready, 0);
  assert.deepEqual(events.map(event => event.state), ['started', 'gave_up']);
  // The other container was asked at the start and every five seconds.
  assert.ok(checks >= 55 && checks <= 62, String(checks));
});

test('the warm-up is skipped without a USPS number or kept sessions', async () => {
  for (const [number, deps, reason] of [['1', { sessions: {} }, 'invalid_number'], [NUMBER, {}, 'no_sessions']]) {
    const events = [];
    let scraped = false;
    const result = await warmUspsSessions({ number, deps, sessions: new UspsSessions(), report: fields => events.push(fields),
      peer: async () => true, scrape: () => { scraped = true; } });
    assert.deepEqual(result, { held: false, ready: 0, ms: 0 });
    assert.deepEqual(events, [{ state: 'skipped', reason }]);
    assert.equal(scraped, false);
  }
});

test('the server opens its port after the warm-up only when a warm-up number is set', () => {
  const source = 'import { getDeps, initPool } from "./deps"\n\nconst app = createApiApp().listen(PORT)\n\nconsole.log("x")\n'
    + 'const poolReady = initPool()\n\npoolReady.catch(() => {})\n';
  const patched = listenAfterUspsWarmup(source);
  assert.match(patched, /^import \{ scrape as uspsWarmupScrape \} from "@trawl\/tiers"\nimport \{ warmUspsSessions \} from "\.\.\/\.\.\/\.\.\/packages\/tiers\/src\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /const app = createApiApp\(\)\nconst uspsWarmupNumber = process\.env\.USPS_WARMUP_NUMBER\?\.trim\(\)\nif \(!uspsWarmupNumber\) app\.listen\(PORT\)\n/);
  assert.ok(patched.includes('const poolReady = initPool()\nif (uspsWarmupNumber) void poolReady\n'
    + '  .then(() => warmUspsSessions({ number: uspsWarmupNumber, deps: getDeps(), scrape: uspsWarmupScrape,\n'
    + '    peerHost: process.env.USPS_WARMUP_PEER?.trim(), port: PORT }))\n  .catch(() => {})\n  .finally(() => app.listen(PORT))\n\npoolReady.catch'));
  assert.doesNotMatch(patched, /createApiApp\(\)\.listen/);
  assert.throws(() => listenAfterUspsWarmup(source.replace('.listen(PORT)', '.listen({ port: PORT })')), /review the USPS warm-up/);
  assert.throws(() => listenAfterUspsWarmup(source.replace('initPool()', 'initPool({})')), /review the USPS warm-up/);
});

test('without another container serving, the port opens at once and the sessions are still prepared', async t => {
  const k = keeper(t);
  const events = [];
  const scrapes = [];
  const result = await warmUspsSessions({ number: NUMBER, deps: { sessions: k.sessions }, sessions: k.keep, report: fields => events.push(fields),
    scrape: req => { scrapes.push(req.url); return k.keep.run(req, k.sessions, k.scrape); } });
  assert.deepEqual(result, { held: false, ready: 0, ms: 0 });
  assert.deepEqual(events, [{ state: 'not_held', reason: 'no_peer' }]);
  await k.advance(5_000);
  assert.deepEqual(scrapes, [URL]);
  assert.equal(k.keep.readyCount, 2);
});

test('the port opens at the first check after the other container stops answering', async t => {
  const k = keeper(t, { outcomes: Object.fromEntries(Array.from({ length: 20 }, (_, n) => [n + 1, ['r', 'r', 'r']])) });
  const events = [];
  let serving = true;
  const done = {};
  warmUspsSessions({ number: NUMBER, deps: { sessions: k.sessions }, sessions: k.keep, report: fields => events.push(fields),
    peer: async () => serving, scrape: (req, deps) => k.keep.run(req, deps.sessions, k.scrape) }).then(value => { done.value = value; });
  await k.advance(30_000);
  assert.equal(done.value, undefined);
  serving = false;
  await k.advance(6_000);
  assert.equal(done.value.held, true);
  assert.ok(done.value.ms >= 30_000 && done.value.ms <= 36_000, String(done.value.ms));
  assert.deepEqual(events.map(event => event.state), ['started', 'peer_gone']);
});
