import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { FEDEX_HOLD_MAX_AGE_MS, FEDEX_HOLD_MAX_LOOKUPS, FEDEX_HOLD_MAX_MEMORY_SHARE, FedExSessions, fedexBrowserPool,
  fedexSessionNumber, fedexSessions } from './fedex-session.mjs';

const API = 'https://api.fedex.com/track/v2/shipments';
const NUMBER = '999999999999';
const OTHER = '999999999998';
const capture = { captureResponses: [API] };
const url = number => `https://www.fedex.com/fedextrack/?trknbr=${number}`;
const payload = number => JSON.stringify({ output: { packages: [{ trackingNbr: number, keyStatus: 'Delivered' }] } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(replies = [], settings = {}) {
  const browser = new EventEmitter();
  const contexts = [], requests = [], replacements = [];
  let policies = 0, navigations = 0;
  browser.newContext = async () => {
    const page = new EventEmitter();
    const context = { closed: false, async close() { this.closed = true; }, async newPage() { return page; } };
    contexts.push(context);
    page.isClosed = () => context.closed;
    page.goto = async target => { navigations++; assert.equal(target, 'https://www.fedex.com/fedextrack/'); await settings.navigationGate; };
    page.content = async () => '<html><body>Tracking</body></html>';
    let entered, opened = false;
    page.locator = () => ({ first: () => ({
      fill: async number => { entered = number; },
      inputValue: async () => entered,
      isVisible: async () => opened,
    }) });
    page.getByRole = (_, { name }) => {
      const act = async () => {
      if (name === 'Track Another Shipment') { opened = true; return; }
      if (!(name instanceof RegExp)) return;
      const spec = replies.shift() ?? {};
      const request = number => ({ url: () => API, method: () => 'POST',
        postDataJSON: () => ({ trackingInfo: [{ trackNumberInfo: { trackingNumber: number } }] }) });
      const response = (req, body, part = spec) => ({ request: () => req,
        status: () => part.status ?? 200,
        headers: () => ({ 'content-type': 'application/json', ...part.headers }),
        body: async () => { await part.bodyGate; return Buffer.from(body); },
      });
      requests.push(entered);
      const req = request(entered);
      if (spec.stale) page.emit('response', response(request(entered), 'stale response'));
      page.emit('request', req);
      if (spec.unrelated) {
        const unrelated = request(OTHER);
        page.emit('request', unrelated);
        page.emit('response', response(unrelated, payload(OTHER)));
      }
      page.emit('response', response(req, spec.body ?? payload(entered)));
      const submittedNumber = entered;
      for (const following of spec.following ?? []) setTimeout(() => {
        if (context.closed) return;
        const next = request(following.number ?? submittedNumber);
        page.emit('request', next);
        if (following.pending) return;
        if (following.failed) page.emit('requestfailed', next);
        else page.emit('response', response(next, following.body ?? payload(submittedNumber), following));
      }, following.after ?? 0);
      opened = false;
      };
      return { evaluate: act, click: async () => {
        if (settings.mouseStallsBeforeSubmit && name instanceof RegExp) throw new Error('Mouse stalled');
        if (settings.mouseStallsBeforeMenu && name === 'Track Another Shipment') throw new Error('Mouse stalled');
        if (settings.consentAbsent && name === 'REJECT OPTIONAL COOKIES') throw new Error('Not found');
        await act();
        if (settings.mouseStallsAfterSubmit && name instanceof RegExp) throw new Error('Mouse stalled');
      } };
    };
    return context;
  };
  const sessions = settings.sessions ?? new FedExSessions({ settleMs: 0, incompleteSettleMs: 0, onRefusal: () => {}, onSessionEnd: () => {}, ...settings });
  const handle = { browser, requestBrowserReplacement: reason => replacements.push(reason) };
  const run = (number = NUMBER, options = {}) => sessions.run({ url: url(number), handle, tier: 3,
    maxTimeout: 1000, capture, installPolicy: async () => { policies++; }, ...options });
  const close = async () => { browser.emit('disconnected'); await tick(); };
  return { browser, contexts, requests, replacements, run, close, policies: () => policies, navigations: () => navigations };
}

test('session route requires the exact FedEx page, one number and one capture endpoint', () => {
  assert.equal(fedexSessionNumber(url(NUMBER), capture), NUMBER);
  assert.equal(fedexSessionNumber(url(NUMBER).replace('/fedextrack/', '/wtrk/track/'), capture), NUMBER);
  // A made-up twenty-digit Ground Economy number.
  assert.equal(fedexSessionNumber(url('61299999999900000010'), capture), '61299999999900000010');
  for (const candidate of [url(NUMBER).replace('www.fedex.com', 'other.test'),
    url(NUMBER).replace('/fedextrack/', '/other/'), url('wrong'), url(NUMBER) + '&trknbr=' + OTHER,
    url('6129999999990000001'), url('612999999999000000100')]) {
    assert.equal(fedexSessionNumber(candidate, capture), null);
  }
  assert.equal(fedexSessionNumber(url(NUMBER), { captureResponses: [API, 'https://other.test'] }), null);
  assert.equal(fedexSessionNumber(url(NUMBER)), null);
});

test('keeps a verified context across tiers and makes a new request for each number', async () => {
  const f = fixture([{}, { unrelated: true }]);
  const cold = await f.run();
  const warm = await f.run(OTHER, { tier: 2 });
  assert.equal(cold.reason, 'fedex-session-new');
  assert.equal(warm.reason, 'fedex-session-reused');
  assert.equal(warm.tier, 2);
  assert.deepEqual(f.requests, [NUMBER, OTHER]);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.policies(), 1);
  assert.equal(f.navigations(), 2);
  assert.equal(JSON.parse(warm.capturedResponses[0].body).output.packages[0].trackingNbr, OTHER);
  assert.deepEqual(warm.cookies, []);
  await f.close();
  assert.equal(f.contexts[0].closed, true);
});

test('ignores a response for another submitted number', async () => {
  const f = fixture([{ unrelated: true }]);
  const result = await f.run();
  assert.equal(JSON.parse(result.capturedResponses[0].body).output.packages[0].trackingNbr, NUMBER);
  await f.close();
});

test('ignores a late response for the same number from an earlier request', async () => {
  const f = fixture([{}, { stale: true }]);
  await f.run();
  const result = await f.run();
  assert.equal(result.capturedResponses[0].body, payload(NUMBER));
  assert.equal(result.reason, 'fedex-session-reused');
  await f.close();
});

test('classifies an edge denial while retaining only safe response headers', async () => {
  const f = fixture([{ status: 403, headers: {
    'content-type': 'text/html; charset=utf-8',
    server: 'AkamaiGHost',
    'retry-after': '30',
    'set-cookie': 'private-value',
    'x-reference-error': 'private-reference',
  } }]);
  const result = await f.run();
  assert.deepEqual(result.capturedResponses[0], {
    url: API,
    status: 403,
    body: null,
    truncated: false,
    base64Encoded: false,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      server: 'AkamaiGHost',
      'retry-after': '30',
    },
    error: 'fedex-edge-denial',
  });
  await f.close();
});

test('retains a refusal and the page\'s later automatic successful reply without submitting twice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reports = [];
  const full = JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, keyStatus: 'Delivered', scanEventList: [{}] }] } });
  const f = fixture([{ status: 403, following: [{ after: 10, body: full }] }],
    { settleMs: 20, incompleteSettleMs: 1000, onRefusal: fields => reports.push(fields) });
  const pending = f.run();
  await tick();
  t.mock.timers.tick(10);
  await tick();
  t.mock.timers.tick(20);
  const result = await pending;
  assert.deepEqual(result.capturedResponses.map(x => x.status), [403, 200]);
  assert.deepEqual(f.requests, [NUMBER]);
  assert.equal(f.contexts[0].closed, false);
  assert.equal(reports[0].responses, 2);
  assert.equal(reports[0].recovered, true);
  await f.close();
});

test('a refusal settles after the short quiet period instead of the wait for a missing history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([{ status: 403 }], { settleMs: 20, incompleteSettleMs: 1000 });
  let done = false;
  const pending = f.run().then(result => { done = true; return result; });
  await tick();
  t.mock.timers.tick(19);
  await tick();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.deepEqual(result.capturedResponses.map(x => x.status), [403]);
  assert.equal(result.durationMs, 20);
  assert.equal(f.contexts[0].closed, true);
  await f.close();
});

test('a scan-less summary still gets the longer wait for its history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const summary = JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, keyStatus: 'In transit' }] } });
  const f = fixture([{ body: summary }], { settleMs: 20, incompleteSettleMs: 1000 });
  let done = false;
  const pending = f.run().then(result => { done = true; return result; });
  await tick();
  t.mock.timers.tick(20);
  await tick();
  assert.equal(done, false);
  t.mock.timers.tick(980);
  const result = await pending;
  assert.equal(result.durationMs, 1000);
  await f.close();
});

test('waits for the history after an initial scan-less summary and retains the sequence', async () => {
  const full = JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, keyStatus: 'Delivered', scanEventList: [{}] }] } });
  const f = fixture([{ following: [{ after: 10, body: full }] }], { settleMs: 5, incompleteSettleMs: 25 });
  const result = await f.run();
  assert.equal(result.capturedResponses.length, 2);
  assert.equal(result.capturedResponses.at(-1).body, full);
  await f.close();
});

test('keeps a final refusal after an earlier success and discards that context', async () => {
  const f = fixture([{ following: [{ after: 10, status: 403 }] }], { incompleteSettleMs: 25 });
  const result = await f.run();
  assert.deepEqual(result.capturedResponses.map(x => x.status), [200, 403]);
  assert.equal(f.contexts[0].closed, true);
  await f.close();
});

test('an unfinished later request cannot leave an earlier success as the answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([{ following: [{ after: 10, pending: true }] }], { incompleteSettleMs: 25 });
  const pending = f.run(NUMBER, { maxTimeout: 1000 });
  await tick();
  t.mock.timers.tick(10);
  await tick();
  t.mock.timers.tick(970);
  const result = await pending;
  assert.deepEqual(result.capturedResponses.map(x => x.status), [200, 0]);
  assert.equal(result.capturedResponses.at(-1).error, 'fedex-tracking-request-failed');
  assert.equal(f.contexts[0].closed, true);
  await f.close();
});

test('caps an automatic response sequence and leaves no response listeners behind', async () => {
  const f = fixture([{ following: Array.from({ length: 30 }, () => ({})) }], { incompleteSettleMs: 25 });
  const result = await f.run();
  assert.equal(result.capturedResponses.length, 20);
  await f.close();
});

test('refusal diagnostics distinguish a new browser from a reused verified session without live data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reports = [];
  const f = fixture([{ status: 403 }, {}, { status: 401 }, { status: 403 }], { onRefusal: fields => reports.push(fields) });
  await f.run();
  t.mock.timers.tick(10);
  await f.run();
  t.mock.timers.tick(20);
  await f.run(OTHER);
  t.mock.timers.tick(30);
  await f.run();
  const phases = { consent: 'clicked', menu: 'clicked', pageMs: 0, formMs: 0, submitMs: 0, replyMs: 0, durationMs: 0 };
  assert.deepEqual(reports, [
    { host: 'api.fedex.com', tier: 3, browser: undefined, statusCode: 403, cause: 'api', session: 'new',
      sessionAgeMs: 0, idleMs: null, browserLookups: 1, sinceSuccessMs: null, ...phases },
    { host: 'api.fedex.com', tier: 3, browser: undefined, statusCode: 401, cause: 'api', session: 'reused',
      sessionAgeMs: 20, idleMs: 20, browserLookups: 3, sinceSuccessMs: 20, ...phases },
    { host: 'api.fedex.com', tier: 3, browser: undefined, statusCode: 403, cause: 'api', session: 'new',
      sessionAgeMs: 0, idleMs: 30, browserLookups: 4, sinceSuccessMs: 50, ...phases },
  ]);
  assert.ok(!JSON.stringify(reports).includes(NUMBER));
  assert.ok(!JSON.stringify(reports).includes(OTHER));
  await f.close();
});

test('refusal diagnostics name an absent consent banner and a menu opened by its handler', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reports = [];
  const f = fixture([{ status: 403 }], { consentAbsent: true, mouseStallsBeforeMenu: true, onRefusal: fields => reports.push(fields) });
  await f.run();
  assert.equal(reports[0].consent, 'absent');
  assert.equal(reports[0].menu, 'handler');
  await f.close();
});

test('refusal reporting cannot turn a captured refusal into a different failure', async () => {
  const f = fixture([{ status: 403 }], { onRefusal: () => { throw new Error('logging unavailable'); } });
  const result = await f.run();
  assert.equal(result.status, 'success');
  assert.equal(result.capturedResponses[0].status, 403);
  assert.equal(f.contexts[0].closed, true);
  await f.close();
});

test('refreshes the same number through the blank form without replacing its context', async () => {
  const f = fixture();
  await f.run();
  assert.equal((await f.run()).reason, 'fedex-session-reused');
  assert.equal(f.contexts.length, 1);
  assert.equal(f.navigations(), 2);
  assert.deepEqual(f.requests, [NUMBER, NUMBER]);
  await f.close();
});

for (const spec of [
  { status: 403 },
  { status: 429, headers: { 'retry-after': '120' } },
  { body: payload(OTHER) },
  { body: '{invalid' },
  { body: JSON.stringify({ output: { packages: [] } }) },
  { headers: { 'content-length': '2000001' } },
]) test(`discards an unverified session and preserves its reply: ${JSON.stringify(spec)}`, async () => {
  const f = fixture([{}, spec, {}]);
  await f.run();
  const rejected = await f.run();
  assert.equal(f.contexts[0].closed, true);
  assert.equal(rejected.capturedResponses[0].status, spec.status ?? 200);
  if (spec.headers?.['retry-after']) assert.equal(rejected.capturedResponses[0].headers['retry-after'], '120');
  assert.equal((await f.run()).reason, 'fedex-session-new');
  assert.equal(f.contexts.length, 2);
  await f.close();
});

test('expires idle contexts and removes their browser listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([], { idleMs: 50 });
  await f.run();
  assert.equal(f.browser.listenerCount('disconnected'), 1);
  t.mock.timers.tick(51);
  await tick();
  assert.equal(f.contexts[0].closed, true);
  assert.equal(f.browser.listenerCount('disconnected'), 0);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

test('successful activity does not extend the maximum session age', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([], { idleMs: 100, maxAgeMs: 150 });
  await f.run();
  t.mock.timers.tick(80);
  assert.equal((await f.run()).reason, 'fedex-session-reused');
  t.mock.timers.tick(71);
  await tick();
  assert.equal(f.contexts[0].closed, true);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

test('rejects overlapping calls without disturbing the active session', async () => {
  let release;
  const f = fixture([{ bodyGate: new Promise(resolve => { release = resolve; }) }]);
  const active = f.run();
  await tick();
  assert.equal((await f.run()).reason, 'FedEx browser session is busy');
  release();
  assert.equal((await active).capturedResponses[0].status, 200);
  assert.equal((await f.run()).reason, 'fedex-session-reused');
  await f.close();
});

test('a budget timeout closes the context and cannot leave a reusable session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release;
  const f = fixture([], { navigationGate: new Promise(resolve => { release = resolve; }) });
  const pending = f.run(NUMBER, { maxTimeout: 20 });
  await tick();
  t.mock.timers.tick(20);
  assert.equal((await pending).status, 'error');
  assert.equal(f.contexts[0].closed, true);
  release();
  await tick();
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

test('returns a captured unreadable body before the deadline without keeping its context', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([{ bodyGate: new Promise(() => {}) }]);
  const pending = f.run(NUMBER, { maxTimeout: 1000 });
  await tick();
  t.mock.timers.tick(980);
  const result = await pending;
  assert.equal(result.status, 'success');
  assert.equal(result.capturedResponses.length, 1);
  assert.equal(result.capturedResponses[0].status, 200);
  assert.equal(result.capturedResponses[0].body, null);
  assert.equal(result.capturedResponses[0].truncated, true);
  assert.equal(result.capturedResponses[0].error, 'tracking response could not be read');
  assert.equal(f.contexts[0].closed, true);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

test('failed cleanup requests browser replacement instead of waiting indefinitely', async () => {
  const f = fixture([{}, { status: 403 }], { closeMs: 10 });
  await f.run();
  f.contexts[0].close = () => new Promise(() => {});
  const result = await f.run();
  assert.equal(result.capturedResponses[0].status, 403);
  assert.deepEqual(f.replacements, ['FedEx session cleanup failed']);
  await f.close();
});

test('a context created after the deadline is closed instead of retained', async () => {
  const f = fixture();
  let finish;
  const context = { closed: false, async close() { this.closed = true; } };
  f.browser.newContext = () => new Promise(resolve => { finish = resolve; });
  assert.equal((await f.run(NUMBER, { maxTimeout: 20 })).status, 'error');
  assert.deepEqual(f.replacements, ['FedEx session setup did not finish']);
  finish(context);
  await tick();
  assert.equal(context.closed, true);
  assert.equal(f.browser.listenerCount('disconnected'), 0);
});

for (const setting of ['mouseStallsBeforeMenu', 'mouseStallsBeforeSubmit', 'mouseStallsAfterSubmit']) {
  test(`recovers a stalled mouse action without duplicate tracking: ${setting}`, async () => {
    const f = fixture([], { [setting]: true });
    assert.equal((await f.run()).capturedResponses[0].status, 200);
    assert.deepEqual(f.requests, [NUMBER]);
    await f.close();
  });
}

test('pool affinity returns to a verified browser and releases rejected affinity', async () => {
  const sessions = new FedExSessions();
  const a = fixture([{ status: 403 }], { sessions });
  const b = fixture([{}, { status: 403 }], { sessions });
  const entries = [{ browser: a.browser }, { browser: b.browser }];
  assert.equal(sessions.preferred(entries, 'www.fedex.com'), entries[0]);
  await a.run();
  assert.equal(sessions.preferred(entries, 'www.fedex.com'), entries[1]);
  await b.run();
  assert.equal(sessions.preferred(entries, 'www.fedex.com'), entries[1]);
  await b.run();
  assert.equal(sessions.preferred(entries, 'www.fedex.com'), entries[0]);
  assert.equal(sessions.preferred(entries, 'other.test'), undefined);
  await a.close(); await b.close();
});


test('session-end warnings identify an inconclusive read that discards verified clearance without exposing reply data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reports = [];
  const empty = JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, keyStatus: 'PRIVATE placeholder',
    recipient: 'PRIVATE recipient', errorList: [{ code: 'TRACKINGNUMBER.NOTFOUND' }] }] } });
  const f = fixture([{}, { body: empty }], { onSessionEnd: fields => reports.push(fields) });
  await f.run();
  t.mock.timers.tick(7);
  const result = await f.run();
  assert.equal(result.capturedResponses[0].body, empty);
  assert.equal(f.contexts[0].closed, true);
  assert.deepEqual(reports, [{ host: 'api.fedex.com', browser: undefined, reason: 'no_tracking',
    sessionAgeMs: 7, lookups: 2, digits: 12, hadVerifiedLookup: true, idleMs: 0, sinceVerifiedMs: 7 }]);
  assert.equal(JSON.stringify(reports).includes(NUMBER), false);
  assert.equal(JSON.stringify(reports).includes('PRIVATE'), false);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

for (const [reason, spec] of [
  ['no_tracking', { body: JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, errorList: [{ code: 'TRACKINGNUMBER.INVALID' }] }] } }) }],
  ['identity', { body: JSON.stringify({ output: { packages: [{ trackingNbr: OTHER, keyStatus: 'PRIVATE' }] } }) }],
  ['empty_result', { body: JSON.stringify({ output: { packages: [] } }) }],
  ['verification_required', { body: JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER, errorList: [{ code: 'AUTHORIZATION.REQUIRED' }] }] } }) }],
  ['missing_status', { body: JSON.stringify({ output: { packages: [{ trackingNbr: NUMBER }] } }) }],
  ['unreadable', { body: '{PRIVATE' }],
  ['api_denied', { status: 403 }],
  ['api_error', { status: 503 }],
]) test(`session-end diagnostics distinguish ${reason} without promoting a cold context`, async () => {
  const reports = [], f = fixture([spec], { onSessionEnd: fields => reports.push(fields) });
  await f.run();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, reason);
  assert.equal(reports[0].hadVerifiedLookup, false);
  assert.equal(reports[0].sinceVerifiedMs, null);
  assert.equal(f.contexts[0].closed, true);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

for (const [reason, settings] of [['idle', { idleMs: 20, maxAgeMs: 100 }], ['max_age', { idleMs: 100, maxAgeMs: 20 }]]) {
  test(`records ${reason} expiry exactly once with the last verified lookup age`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const reports = [], f = fixture([], { ...settings, onSessionEnd: fields => reports.push(fields) });
    await f.run();
    t.mock.timers.tick(21);
    await tick();
    assert.equal(f.contexts[0].closed, true);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, reason);
    assert.equal(reports[0].hadVerifiedLookup, true);
    assert.equal(reports[0].idleMs, 21);
    assert.equal(reports[0].sinceVerifiedMs, 21);
    await f.close();
    assert.equal(reports.length, 1);
  });
}

test('names a disconnected browser and an unexpectedly closed page separately', async () => {
  const reports = [], f = fixture([], { onSessionEnd: fields => reports.push(fields) });
  await f.run();
  f.contexts[0].closed = true;
  await f.run();
  assert.equal(reports[0].reason, 'page_closed');
  await f.close();
  assert.equal(reports[1].reason, 'browser_disconnected');
});

test('a failed session-end reporter cannot prevent disposal or change the captured reply', async () => {
  const f = fixture([{ status: 403 }], { onSessionEnd: () => { throw new Error('PRIVATE diagnostics'); } });
  assert.equal((await f.run()).capturedResponses[0].status, 403);
  assert.equal(f.contexts[0].closed, true);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  await f.close();
});

const GIB = 1024 ** 3;
const memory = (workingSetBytes, limitBytes = 4 * GIB) => () => ({ currentBytes: 4 * GIB, workingSetBytes, limitBytes });
const holding = (settings = {}) => {
  const holds = [];
  const sessions = new FedExSessions({ settleMs: 0, incompleteSettleMs: 0, onRefusal: () => {}, onSessionEnd: () => {},
    onHold: fields => holds.push(fields), ...settings });
  return { holds, sessions };
};

test('the hold limits are named constants that sessions use by default', () => {
  const sessions = new FedExSessions();
  assert.equal(sessions.holdMaxLookups, FEDEX_HOLD_MAX_LOOKUPS);
  assert.equal(sessions.holdMaxAgeMs, FEDEX_HOLD_MAX_AGE_MS);
  assert.equal(sessions.holdMaxMemoryShare, FEDEX_HOLD_MAX_MEMORY_SHARE);
  assert.ok(FEDEX_HOLD_MAX_LOOKUPS > 8 && FEDEX_HOLD_MAX_AGE_MS > 0 && FEDEX_HOLD_MAX_MEMORY_SHARE < 0.85);
});

test('holds a browser with a verified session past its recycle count until the lookup cap', async () => {
  const { holds, sessions } = holding({ holdMaxLookups: 3 });
  const f = fixture([], { sessions });
  await f.run();
  const entry = { id: 1, browser: f.browser, temporaryContextUses: 8 };
  // The cgroup's working set leaves out reclaimable file cache, as TRAWL's pool does.
  assert.equal(sessions.holds(entry, memory(2 * GIB)), true);
  assert.equal(sessions.holds(entry, memory(2 * GIB)), true);
  assert.deepEqual(holds, [{ host: 'api.fedex.com', state: 'held', browser: 1, contexts: 8, sessionLookups: 1,
    sessionAgeMs: holds[0].sessionAgeMs, memoryPercent: 50 }]);
  // Other carriers' new contexts and FedEx's own lookups both count.
  entry.temporaryContextUses = 10;
  assert.equal(sessions.holds(entry, memory(2 * GIB)), true);
  assert.equal((await f.run(OTHER)).reason, 'fedex-session-reused');
  assert.equal(sessions.holds(entry, memory(2 * GIB)), false);
  assert.equal(holds.length, 2);
  assert.equal(holds[1].state, 'ended');
  assert.equal(holds[1].reason, 'lookups');
  assert.equal(holds[1].lookups, 3);
  assert.equal(holds[1].contexts, 10);
  assert.equal(holds[1].sessionLookups, 2);
  // The pool now recycles as usual; the session lasts until it does.
  assert.equal(f.contexts[0].closed, false);
  assert.equal(sessions.holds(entry, memory(GIB)), false);
  assert.equal(holds.length, 2);
  assert.equal(JSON.stringify(holds).includes(NUMBER), false);
  assert.equal(JSON.stringify(holds).includes(OTHER), false);
  await f.close();
  assert.equal(holds.length, 2);
});

test('ends a hold at its maximum age', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { holds, sessions } = holding({ holdMaxAgeMs: 100 });
  const f = fixture([], { sessions });
  await f.run();
  const entry = { id: 0, browser: f.browser, temporaryContextUses: 8 };
  t.mock.timers.tick(5);
  assert.equal(sessions.holds(entry, memory(GIB)), true);
  t.mock.timers.tick(99);
  assert.equal(sessions.holds(entry, memory(GIB)), true);
  t.mock.timers.tick(1);
  assert.equal(sessions.holds(entry, memory(GIB)), false);
  assert.deepEqual(holds.map(row => [row.state, row.reason]), [['held', undefined], ['ended', 'age']]);
  assert.equal(holds[1].heldMs, 100);
  assert.equal(holds[1].sessionAgeMs, 105);
  await f.close();
});

test('memory above the threshold declines or ends a hold, and an unreadable limit declines it', async () => {
  for (const [usage, reason, percent] of [[memory(3 * GIB), 'memory', 75], [memory(GIB, null), 'memory_unknown', null],
    [undefined, 'memory_unknown', null], [() => { throw new Error('PRIVATE'); }, 'memory_unknown', null]]) {
    const { holds, sessions } = holding();
    const f = fixture([], { sessions });
    await f.run();
    const entry = { id: 0, browser: f.browser, temporaryContextUses: 8 };
    assert.equal(sessions.holds(entry, usage), false);
    assert.deepEqual(holds.map(row => [row.state, row.reason, row.memoryPercent]), [['declined', reason, percent]]);
    // A declined browser is recycled as usual and never held later.
    assert.equal(sessions.holds(entry, memory(GIB)), false);
    assert.equal(holds.length, 1);
    await f.close();
  }
  const { holds, sessions } = holding();
  const f = fixture([], { sessions });
  await f.run();
  const entry = { id: 0, browser: f.browser, temporaryContextUses: 8 };
  assert.equal(sessions.holds(entry, memory(2.8 * GIB)), true);
  assert.equal(sessions.holds(entry, memory(2.9 * GIB)), false);
  assert.deepEqual(holds.map(row => [row.state, row.reason, row.memoryPercent]), [['held', undefined, 70], ['ended', 'memory', 73]]);
  await f.close();
});

test('only a working verified session holds its browser, and a lookup in progress keeps the hold', async () => {
  const { holds, sessions } = holding();
  const entryOf = f => ({ id: 0, browser: f.browser, temporaryContextUses: 8 });
  assert.equal(sessions.holds({ id: 0, browser: new EventEmitter(), temporaryContextUses: 8 }, memory(GIB)), false);
  assert.equal(sessions.holds({ id: 0 }, memory(GIB)), false);
  const refused = fixture([{ status: 403 }], { sessions });
  await refused.run();
  assert.equal(sessions.holds(entryOf(refused), memory(GIB)), false);
  // A new session is not verified before its first reply.
  let first;
  const cold = fixture([{ bodyGate: new Promise(resolve => { first = resolve; }) }], { sessions });
  const opening = cold.run();
  await tick();
  assert.equal(sessions.holds(entryOf(cold), memory(GIB)), false);
  first();
  await opening;
  // A verified session's next lookup clears its verification until the reply.
  let next;
  const f = fixture([{}, { bodyGate: new Promise(resolve => { next = resolve; }) }], { sessions });
  await f.run();
  assert.equal(sessions.holds(entryOf(f), memory(GIB)), true);
  const active = f.run(OTHER);
  await tick();
  assert.equal(sessions.holds(entryOf(f), memory(GIB)), true);
  next();
  assert.equal((await active).reason, 'fedex-session-reused');
  assert.equal(sessions.holds(entryOf(f), memory(GIB)), true);
  assert.deepEqual(holds.map(row => row.state), ['held']);
  await refused.close(); await cold.close(); await f.close();
});

test('a session that ends ends its hold, and a later session cannot hold the same browser', async () => {
  const { holds, sessions } = holding();
  const f = fixture([{}, { status: 403 }, {}], { sessions });
  await f.run();
  const entry = { id: 0, browser: f.browser, temporaryContextUses: 8 };
  assert.equal(sessions.holds(entry, memory(GIB)), true);
  await f.run();
  assert.equal(f.contexts[0].closed, true);
  assert.deepEqual(holds.map(row => [row.state, row.reason]), [['held', undefined], ['ended', 'session_end']]);
  assert.equal(holds[1].sessionLookups, 2);
  assert.equal((await f.run()).reason, 'fedex-session-new');
  assert.equal(sessions.holds(entry, memory(GIB)), false);
  assert.equal(holds.length, 2);
  await f.close();
});

test('a failed hold reporter cannot change the decision', async () => {
  const { sessions } = holding({ onHold: () => { throw new Error('PRIVATE'); } });
  const f = fixture([], { sessions });
  await f.run();
  assert.equal(sessions.holds({ id: 0, browser: f.browser, temporaryContextUses: 8 }, memory(GIB)), true);
  await f.close();
});

// TRAWL's pool, reduced to the lease choice and rolling replacement. The lines
// the patch changes are kept as upstream writes them.
const upstreamPool = `import type { PoolBrowser } from "@trawl/types"

export class BrowserPool {
  private entries: PoolBrowser[] = []
  private replacementRunning = false
  private memoryUsage?: () => { currentBytes: number | null; limitBytes: number | null; workingSetBytes?: number } | undefined
  warming?: (entry: PoolBrowser) => Promise<void>

  constructor({ entries, memoryUsage }: { entries: PoolBrowser[]; memoryUsage?: () => undefined }) {
    this.entries = entries
    this.memoryUsage = memoryUsage
  }

  pickEntry(domain?: string): PoolBrowser | undefined {
    const available = this.entries.filter((e) => !e.busy)
    if (available.length === 0) return
    if (domain) {
      const sticky = available.find((e) => e.lastDomain === domain)
      if (sticky) return sticky
    }
    return available[0]
  }

  async runNextRollingReplacement(): Promise<void> {
    if (this.replacementRunning) return
    const entry = this.entries.find(
      (candidate) =>
        candidate.replacementRequested &&
        !candidate.restarting &&
        !candidate.busy &&
        !candidate.cleaning &&
        (!candidate.retainedContexts || candidate.replacementRecovery),
    )
    if (!entry) return
    this.replacementRunning = true
    const reason = entry.replacementRequested as string
    const recovery = Boolean(entry.replacementRecovery)
    entry.replacementRequested = undefined
    entry.replacementRecovery = false
    try {
      await this.warming?.(entry)
      if (entry.retainedContexts && !recovery) {
        entry.replacementRequested ??= reason
        return
      }
      while (entry.busy) await new Promise((resolve) => setTimeout(resolve, 1))
      if (entry.retainedContexts && !recovery) {
        entry.replacementRequested ??= reason
        return
      }
      entry.replaced = reason
    } finally {
      this.replacementRunning = false
    }
  }
}
`;

// The patched pool asks the image's singleton, which the fixtures share here without its reply waits.
async function patchedPool(t) {
  const { settleMs, incompleteSettleMs } = fedexSessions;
  Object.assign(fedexSessions, { settleMs: 0, incompleteSettleMs: 0 });
  t.after(() => Object.assign(fedexSessions, { settleMs, incompleteSettleMs }));
  const source = fedexBrowserPool(upstreamPool).replace('"../../tiers/src/utils/fedex-session.mjs"',
    JSON.stringify(new URL('./fedex-session.mjs', import.meta.url).href));
  const js = stripTypeScriptTypes(source, { mode: 'strip' });
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).BrowserPool;
}

test('the patched pool keeps a held browser through recycles but not through recovery replacements', async t => {
  const reports = []; t.mock.method(console, 'warn', text => { reports.push(JSON.parse(text)); });
  const BrowserPool = await patchedPool(t);
  const held = fixture([], { sessions: fedexSessions }), other = fixture([], { sessions: fedexSessions });
  await held.run();
  const a = { id: 0, browser: held.browser, temporaryContextUses: 8, replacementRequested: '8 temporary contexts created' };
  const b = { id: 1, browser: other.browser, temporaryContextUses: 8, replacementRequested: '8 temporary contexts created' };
  const pool = new BrowserPool({ entries: [a, b], memoryUsage: memory(GIB) });
  assert.equal(pool.pickEntry('www.fedex.com'), a);
  await pool.runNextRollingReplacement();
  assert.equal(a.replaced, undefined);
  assert.equal(a.replacementRequested, '8 temporary contexts created');
  // Browser B holds no FedEx session, so it recycles as usual.
  assert.equal(b.replaced, '8 temporary contexts created');
  await pool.runNextRollingReplacement();
  assert.equal(a.replaced, undefined);
  assert.deepEqual(reports.map(row => [row.event, row.state, row.browser]), [['fedex.browser-hold', 'held', 0]]);
  a.replacementRecovery = true;
  await pool.runNextRollingReplacement();
  assert.equal(a.replaced, '8 temporary contexts created');
  await held.close(); await other.close();
});

test('the patched pool rechecks the hold once the replacement is warm', async t => {
  t.mock.method(console, 'warn', () => {});
  const BrowserPool = await patchedPool(t);
  const f = fixture([{ status: 403 }, {}], { sessions: fedexSessions });
  await f.run();
  const entry = { id: 0, browser: f.browser, temporaryContextUses: 8, replacementRequested: '8 temporary contexts created' };
  const pool = new BrowserPool({ entries: [entry], memoryUsage: memory(GIB) });
  // A new session is verified on the incumbent while its replacement warms.
  pool.warming = async () => { await f.run(); };
  await pool.runNextRollingReplacement();
  assert.equal(entry.replaced, undefined);
  assert.equal(entry.replacementRequested, '8 temporary contexts created');
  // Once that session ends, even a session verified during the next warm-up cannot hold the browser.
  await f.close();
  await pool.runNextRollingReplacement();
  assert.equal(entry.replaced, '8 temporary contexts created');
});

test('the pool patch refuses an upstream pool whose patched lines changed', () => {
  assert.throws(() => fedexBrowserPool(upstreamPool.replace('(!candidate.retainedContexts || candidate.replacementRecovery)',
    '!candidate.retainedContexts')), /TRAWL browser pool changed/);
  assert.throws(() => fedexBrowserPool(upstreamPool.replace('      if (entry.retainedContexts && !recovery) {', '      if (!recovery) {')),
    /TRAWL browser pool changed/);
  assert.throws(() => fedexBrowserPool(upstreamPool.replace('if (domain) {', 'if (domain !== undefined) {')), /TRAWL browser pool changed/);
});

test('the image installs the pool patch from the helper it imports', () => {
  assert.match(readFileSync(new URL('./install.mjs', import.meta.url), 'utf8'),
    /import \{ fedexBrowserPool \} from '\/app\/packages\/tiers\/src\/utils\/fedex-session\.mjs';/);
});
