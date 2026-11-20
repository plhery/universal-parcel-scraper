import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachUspsTrackingCapture, forgetUspsOutageSessions, keepUspsSession, USPS_SESSION_MAX_AGE_MS, UspsSessions, uspsCaptureNumber, uspsOutage } from './usps-tracking.mjs';

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
    '        if (cookies.length > 0 && !explicitProxy && !importedCookies) {',
    '          await deps.saveSession(domain, {})',
    '        }',
    '      }',
    '      if (hasUsablePayload(t4) && !crossed4) {',
    '      const cookies: Cookie[] = t4.cookies ?? []',
    '      if (cookies.length > 0 && !explicitProxy && !importedCookies) {',
  ].join('\n');
  const patched = forgetUspsOutageSessions(source);
  assert.match(patched, /^import \{ uspsOutage \} from "\.\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /if \(uspsOutage\(t2\)\) await deps\.invalidateSession\(domain\)\n {8}else if \(t2\.cookies/);
  assert.match(patched, /!importedCookies && !uspsOutage\(t3\)\) \{/);
  assert.equal(patched.split('uspsOutage(').length, 3);
  assert.throws(() => forgetUspsOutageSessions(source.replace('t2.cookies &&', 't2.cookies?.length &&')), /review the USPS outage session patch/);
  assert.throws(() => forgetUspsOutageSessions(source + '\n        if (t2.cookies && t2.cookies.length > 0) {'), /review the USPS outage session patch/);
});

function keeper(overrides = {}) {
  let clock = 0;
  const events = [], waits = [], reads = [];
  const live = new Set();
  const sessions = {
    created: [], destroyed: [],
    async list() { return [...live].map(id => ({ id })); },
    async create({ id }) { if (overrides.createStatus) throw Object.assign(new Error('x'), { statusCode: overrides.createStatus }); this.created.push(id); live.add(id); },
    async destroy(id) { this.destroyed.push(id); live.delete(id); },
  };
  const keep = new UspsSessions({ now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; },
    report: fields => events.push(fields), ...overrides.options });
  const outcomes = [...(overrides.outcomes ?? [])];
  const scrape = async req => {
    reads.push(req);
    clock += 2_000;
    const outcome = outcomes.shift() ?? 'T';
    if (outcome instanceof Error) throw outcome;
    return outcome === 'r'
      ? { html: '<html></html>', capturedResponses: [{ url: URL, status: 302, headers: { location: OUTAGE }, trackingNumberSubmitted: NUMBER }] }
      : outcome === '?' ? { html: '<html></html>', capturedResponses: [] }
      : { html: `<input id="trackingNum" value="${NUMBER}">`, capturedResponses: [] };
  };
  const read = (extra = {}) => keep.run({ url: URL, ...OPTIONS, skipHttp: true, maxTier: 3, maxTimeout: 45_000, ...extra }, sessions, scrape);
  return { keep, sessions, read, reads, waits, events, live, tick: ms => { clock += ms; } };
}

test('only an ordinary USPS tracking read without a proxy, cookies or session of its own uses the kept session', () => {
  const keep = new UspsSessions();
  const req = { url: URL, ...OPTIONS, maxTier: 3 };
  assert.equal(keep.routes(req, {}), true);
  assert.equal(keep.routes(req, undefined), false);
  for (const extra of [{ sessionId: 'mine' }, { proxy: 'http://proxy.example:8080' }, { cookies: [{ name: 'a', value: 'b' }] },
    { maxTier: 2 }, { contentWaitForSelector: 'body' }, { url: URL + '?x=1' }]) assert.equal(keep.routes({ ...req, ...extra }, {}), false);
});

test('a new session gets spaced trial reads, and one USPS lets through is kept for later reads', async () => {
  const k = keeper({ outcomes: ['r', 'r', 'T', 'T'] });
  for (let i = 0; i < 3; i++) await k.read();
  k.tick(600_000);
  await k.read();
  assert.deepEqual(k.sessions.created, ['usps-tracking-1']);
  assert.deepEqual(k.sessions.destroyed, []);
  assert.deepEqual(k.reads.map(req => req.sessionId), Array(4).fill('usps-tracking-1'));
  assert.deepEqual(k.waits, [8_000, 8_000]);
  assert.ok(k.reads.every(req => req.maxTimeout <= 45_000 && req.url === URL));
  assert.deepEqual(k.events.map(e => e.state), ['created', 'accepted']);
  assert.equal(k.events[1].reads, 3);
});

test('a session refused through its trial is replaced, and a kept one after two refusals in a row', async () => {
  const k = keeper({ outcomes: ['r', 'r', 'r', 'T', 'r', 'T', 'r', 'r', 'T'] });
  for (let i = 0; i < 9; i++) await k.read();
  assert.deepEqual(k.sessions.created, ['usps-tracking-1', 'usps-tracking-2', 'usps-tracking-3']);
  assert.deepEqual(k.sessions.destroyed, ['usps-tracking-1', 'usps-tracking-2']);
  assert.deepEqual(k.events.filter(e => e.state === 'ended').map(e => [e.reason, e.reads, e.accepted]),
    [['not_accepted', 3, false], ['refused', 5, true]]);
});

test('an expired, aged or vanished session is replaced, and failed reads end it', async () => {
  const k = keeper({ outcomes: ['T', 'T', 'T', Object.assign(new Error('gone'), { statusCode: 410 }), 'T',
    new Error('a'), new Error('b'), 'T'] });
  await k.read();
  k.live.clear();
  await k.read();
  k.tick(USPS_SESSION_MAX_AGE_MS);
  await k.read();
  await assert.rejects(k.read(), /gone/);
  await k.read();
  await assert.rejects(k.read(), /^Error: a$/);
  await assert.rejects(k.read(), /^Error: b$/);
  await k.read();
  assert.deepEqual(k.events.filter(e => e.state === 'ended').map(e => e.reason), ['expired', 'max_age', 'gone', 'failed']);
  assert.equal(k.sessions.created.length, 5);
});

test('an unreadable trial read counts toward the trial without ending a kept session', async () => {
  const k = keeper({ outcomes: ['?', '?', '?', 'T', '?', '?', '?'] });
  for (let i = 0; i < 7; i++) await k.read();
  assert.deepEqual(k.events.filter(e => e.state === 'ended').map(e => e.reason), ['not_accepted']);
});

test('without room for a session of its own a read goes in a fresh browser as before', async () => {
  const k = keeper({ createStatus: 429 });
  const result = await k.read();
  assert.equal(k.reads[0].sessionId, undefined);
  assert.match(result.html, /trackingNum/);
  const other = keeper({ createStatus: 500 });
  await assert.rejects(other.read(), /x/);
});

test('reads take turns, and a read whose budget runs out in line gives up without jumping the queue', async () => {
  let clock = 0, open = 0, most = 0;
  const live = new Set();
  const sessions = { async list() { return [...live].map(id => ({ id })); }, async create({ id }) { live.add(id); }, async destroy(id) { live.delete(id); } };
  const keep = new UspsSessions({ now: () => clock, report: () => {}, minReadMs: 50, spacingMs: 0 });
  const gates = [];
  const scrape = async () => {
    open++; most = Math.max(most, open);
    await new Promise(resolve => gates.push(resolve));
    open--;
    return { html: '<input id="trackingNum">', capturedResponses: [] };
  };
  const req = { url: URL, ...OPTIONS, maxTier: 3 };
  const first = keep.run({ ...req, maxTimeout: 60_000 }, sessions, scrape);
  const late = keep.run({ ...req, maxTimeout: 60 }, sessions, scrape);
  const third = keep.run({ ...req, maxTimeout: 60_000 }, sessions, scrape);
  await assert.rejects(late, /USPS browser session is busy/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(gates.length, 1);
  gates.shift()();
  await first;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(gates.length, 1);
  gates.shift()();
  await third;
  assert.equal(most, 1);
});

test('the orchestrator sends ordinary USPS reads through the kept session', () => {
  const entry = 'export async function scrape(\n  req: ScrapeRequest,\n  deps: OrchestratorDeps,\n'
    + '  runners: OrchestratorRunners = {},\n): Promise<ScrapeResult> {\n  const started = Date.now()\n';
  const patched = keepUspsSession('import { x } from "./x"\n' + entry);
  assert.match(patched, /^import \{ uspsSessions \} from "\.\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /Promise<ScrapeResult> \{\n {2}if \(uspsSessions\.routes\(req, deps\.sessions\)\) return uspsSessions\.run\(req, deps\.sessions!, \(read\) => scrape\(read, deps, runners\)\)\n {2}const started/);
  assert.throws(() => keepUspsSession(entry.replace('runners: OrchestratorRunners = {}', 'runners = {}')), /review the USPS kept session/);
});
