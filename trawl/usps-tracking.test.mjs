import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachUspsTrackingCapture, forgetUspsOutageSessions, keepUspsSession, USPS_IDLE_MS, USPS_SESSION_MAX_AGE_MS, UspsSessions, uspsCaptureNumber, uspsOutage } from './usps-tracking.mjs';

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
    '          await deps.saveSession(domain, {})',
    '        }',
    '      }',
    '      if (hasUsablePayload(t3) && !crossed3) {',
    '        const cookies: Cookie[] = t3.cookies ?? []',
    '        if (cookies.length > 0 && !explicitProxy && !privateRequest) {',
    '          await deps.saveSession(domain, {})',
    '        }',
    '      }',
    '      if (hasUsablePayload(t4) && !crossed4) {',
    '      const cookies: Cookie[] = t4.cookies ?? []',
    '      if (cookies.length > 0 && !explicitProxy && !privateRequest) {',
  ].join('\n');
  const patched = forgetUspsOutageSessions(source);
  assert.match(patched, /^import \{ uspsOutage \} from "\.\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /if \(uspsOutage\(t2\)\) await deps\.invalidateSession\(domain\)\n {8}else if \(t2\.cookies/);
  assert.match(patched, /!privateRequest && !uspsOutage\(t3\)\) \{/);
  assert.equal(patched.split('uspsOutage(').length, 3);
  assert.throws(() => forgetUspsOutageSessions(source.replace('t2.cookies &&', 't2.cookies?.length &&')), /review the USPS outage session patch/);
  assert.throws(() => forgetUspsOutageSessions(source + '\n        if (t2.cookies && t2.cookies.length > 0) {'), /review the USPS outage session patch/);
});

// Mocked clock and timers: `advance` lets the background preparation and the reads run for that long.
function keeper(t, { outcomes = {}, createStatus, options } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const events = [], reads = [], live = new Set();
  let active = 0, most = 0;
  const sessions = {
    created: [], destroyed: [],
    async list() { return [...live].map(id => ({ id })); },
    async create({ id }) {
      if (createStatus) throw Object.assign(new Error('x'), { statusCode: createStatus });
      this.created.push(id); live.add(id);
    },
    async destroy(id) { this.destroyed.push(id); live.delete(id); },
  };
  const keep = new UspsSessions({ report: fields => events.push(fields), ...options });
  const scrape = async req => {
    reads.push({ id: req.sessionId, at: Date.now(), maxTimeout: req.maxTimeout, url: req.url });
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
  return { keep, sessions, read, reads, events, live, advance, most: () => most };
}
const states = events => events.map(event => event.reason ?? event.state);
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

test('the orchestrator sends ordinary USPS reads through the kept session', () => {
  const entry = 'export async function scrape(\n  req: ScrapeRequest,\n  deps: OrchestratorDeps,\n'
    + '  runners: OrchestratorRunners = {},\n): Promise<ScrapeResult> {\n  const started = Date.now()\n';
  const patched = keepUspsSession('import { x } from "./x"\n' + entry);
  assert.match(patched, /^import \{ uspsSessions \} from "\.\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /Promise<ScrapeResult> \{\n {2}if \(uspsSessions\.routes\(req, deps\.sessions\)\) return uspsSessions\.run\(req, deps\.sessions!, \(read\) => scrape\(read, deps, runners\)\)\n {2}const started/);
  assert.throws(() => keepUspsSession(entry.replace('runners: OrchestratorRunners = {}', 'runners = {}')), /review the USPS kept session/);
});
