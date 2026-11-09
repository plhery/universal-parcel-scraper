import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jdDomesticNumber, jdDomesticReply, jdDisplayedPuzzle, jdRefreshGeometry, runJdDomestic } from './jd-domestic-browser.mjs';
import { jdIconGeometry } from './jd-icon.mjs';

const number = 'JDJ146283975062', other = 'JDJ257394086173';
const pageUrl = 'https://www.jdl.com/orderSearch/';
const track = 'https://www.jdl.com/waybill/trackNoPin';
const proxy = 'https://api.jdl.com/waybillQuery/trackWaybill';
const verify = 'https://api.jdl.com/waybillQuery/needVerify';
const sessionUrl = 'https://www.jdl.com/ecology/getSession';
const url = `${pageUrl}?waybillCodes=${number}`, capture = { captureResponses: [track, proxy] };
const puzzle = { scene: 'data:image/png;base64,AA==', tip: 'data:image/png;base64,AQ==' };
const secondPuzzle = { scene: 'data:image/png;base64,Ag==', tip: 'data:image/png;base64,Aw==' };
const payload = () => ({ code: 1, token: 'PRIVATE', obj: [{ rawWaybillCode: number, exists: true, receiverName: 'PRIVATE', map: 'PRIVATE',
  traceAllVoList: [{ categoryName: 'In transit', traceVoList: [{ operateMessage: 'In transit', trackDay: '2026-04-03', trackTime: '12:00:00',
    recipientName: 'PRIVATE', phone: 'PRIVATE', attachments: ['PRIVATE'] }] }] }] });

function fixture({ plan = { x: 30, y: 40 }, verified = true, restarted = false, wrongRequest = false, wrongSession = false, proof = 'PRIVATE-PROOF', body = payload(), status = 200, stale = false, plans, decline = 'unreadable', refreshStale = false, refreshSession = false } = {}) {
  const state = { contexts: 0, closed: 0, plans: 0, clicks: 0, requests: 0, blocked: 0, started: 0, captures: [], refreshes: 0 };
  const listeners = new Map();
  const request = (target, method = 'GET', data) => ({ url: () => target, method: () => method, postDataJSON: () => data });
  const emit = async (target, value, code = 200, req = request(target)) => {
    listeners.get('response')?.({ request: () => req, url: () => target, status: () => code,
      body: async () => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
    await new Promise(resolve => setImmediate(resolve));
  };
  const history = async () => {
    const target = verified ? `${track}?${new URLSearchParams({ waybillCodes: wrongRequest ? other : number,
      sessionId: wrongSession ? 'PRIVATE-OTHER' : 'PRIVATE-SESSION', verifyCode: proof, type: '2', groupFlag: 'true' })}` : proxy;
    const req = request(target, verified ? 'GET' : 'POST', [{ waybillCodes: wrongRequest ? other : number, type: 2, pin: '' }]);
    await state.route({ request: () => req,
      fallback: async () => { state.requests++; await emit(target, body, status, req); },
      abort: async () => { state.blocked++; },
    });
  };
  const tab = {
    route: async (matcher, handler) => { state.route = handler; assert.equal(matcher(new URL(track)), true); },
    on: (event, fn) => listeners.set(event, fn), off: event => listeners.delete(event),
    goto: async target => {
      assert.equal(target, url); state.started++;
      await emit(verify, { code: 1, obj: verified });
      if (verified) {
        await emit(sessionUrl, { code: 1, obj: 'PRIVATE-SESSION' });
        if (restarted) await emit(sessionUrl, { code: 1, obj: 'PRIVATE-RESTART' });
      } else await history();
      return { status: () => 200 };
    },
    evaluate: async fn => {
      if (fn === jdDisplayedPuzzle) return state.refreshes && !refreshStale ? secondPuzzle : puzzle;
      if (fn === jdRefreshGeometry) return { x: 500, y: 20 };
      if (fn === jdIconGeometry) return stale ? null : { x: 30, y: 40 };
      throw new Error('Unexpected page operation');
    },
    mouse: { click: async x => {
      if (x === 500) {
        state.refreshes++;
        if (refreshSession) await emit(sessionUrl, { code: 1, obj: 'PRIVATE-NEW-SESSION' });
      } else { state.clicks++; await history(); }
    } },
  };
  const context = { newPage: async () => tab, close: async () => { state.closed++; } };
  const options = { url, capture, tier: 3, maxTimeout: 8000,
    handle: { browser: { newContext: async () => { state.contexts++; return context; } } },
    installPolicy: async () => {}, locate: async (input, _signal, budget, report) => {
      const selected = plans ? plans[state.plans] : plan;
      state.plans++; assert.deepEqual(input, state.refreshes ? secondPuzzle : puzzle); assert.ok(budget <= 3000);
      report(selected ? 'planned' : decline); return selected;
    }, onVerification: event => state.captures.push(event) };
  return { state, options, tab };
}

test('the helper is scoped to whole JD waybills outside the international series and both official capture endpoints', () => {
  assert.equal(jdDomesticNumber(url, capture), number);
  for (const series of ['JD0146283975062', 'JDV146283975062', 'JDVA14628397506', 'JDAZ14628397506', 'JDQ146283975062']) {
    assert.equal(jdDomesticNumber(url.replace(number, series), capture), series);
  }
  for (const target of [url + '&waybillCodes=' + other, url + '#extra', url.replace(number, 'JDW146283975062'),
    url.replace(number, 'JDAP14628397506'), url.replace(number, 'JD14628397506'), url.replace(number, 'VG14628397506'),
    url.replace('www.jdl.com', 'example.test'), url.replace('www.jdl.com', 'user@www.jdl.com')]) assert.equal(jdDomesticNumber(target, capture), null);
  assert.equal(jdDomesticNumber(url, { captureResponses: [track] }), null);
});

test('abstention closes immediately without a click, refresh, tracking request or private output', async () => {
  const active = fixture({ plan: null });
  const result = await runJdDomestic(active.options);
  assert.equal(active.state.plans, 1); assert.equal(active.state.clicks, 0); assert.equal(active.state.requests, 0);
  assert.equal(active.state.refreshes, 0); assert.equal(active.state.closed, 1);
  assert.equal(result.capturedResponses[0].error, 'jd-domestic-unreadable');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('foreground abstention logs only its rejected count without a tracking request', async () => {
  for (const count of [0, 59, 901, 3888, -1, 1.5, 60, 900, 3889, '901', undefined]) {
    const active = fixture({ plan: null });
    active.options.locate = async (_input, _signal, _budget, report) => { report('foreground', count); return null; };
    await runJdDomestic(active.options);
    const event = active.state.captures[0];
    assert.equal(event.analysis, 'foreground');
    if ([0, 59, 901, 3888].includes(count)) assert.equal(event.foregroundPixels, count);
    else assert.equal('foregroundPixels' in event, false);
    assert.equal(active.state.clicks, 0); assert.equal(active.state.requests, 0);
    assert.equal(active.state.refreshes, 0); assert.equal(active.state.closed, 1);
    assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(event).includes('image'), false);
  }
});

test('accepted original-session verification retains only the whole-bound tracking fields', async () => {
  const active = fixture(), result = await runJdDomestic(active.options);
  assert.equal(active.state.requests, 1); assert.equal(active.state.clicks, 1); assert.equal(active.state.closed, 1);
  assert.equal(result.capturedResponses[0].trackingNumberSubmitted, number);
  assert.deepEqual(JSON.parse(result.capturedResponses[0].body), jdDomesticReply(payload()));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.deepEqual(active.state.captures.map(x => x.outcome), ['response']);
});

test('a replacement guest session or stale image never submits tracking', async () => {
  for (const setup of [{ restarted: true }, { stale: true }]) {
    const active = fixture(setup), result = await runJdDomestic(active.options);
    assert.equal(active.state.requests, 0); assert.equal(active.state.clicks, 0); assert.equal(active.state.closed, 1);
    assert.equal(result.capturedResponses[0].body, null);
    assert.ok(result.durationMs < 500, 'Declined or changed state must not wait out the lookup budget');
  }
});

test('a mismatched tracking request is aborted instead of being captured', async () => {
  for (const setup of [{ wrongRequest: true }, { wrongSession: true }, { proof: '' }]) {
    const active = fixture(setup), result = await runJdDomestic(active.options);
    assert.equal(active.state.requests, 0); assert.equal(active.state.blocked, 1);
    assert.equal(result.capturedResponses[0].error, 'jd-domestic-verification_refused');
  }
});

test('only the service-selected no-verification branch can submit the official proxy query', async () => {
  const active = fixture({ verified: false }), result = await runJdDomestic(active.options);
  assert.equal(active.state.plans, 0); assert.equal(active.state.clicks, 0); assert.equal(active.state.requests, 1);
  assert.equal(result.capturedResponses[0].url, proxy);
});

test('HTTP refusal and malformed final bodies are retained, never rewritten as a successful history', async () => {
  for (const setup of [{ status: 403 }, { body: '<html>PRIVATE block</html>' }]) {
    const active = fixture(setup), result = await runJdDomestic(active.options);
    assert.equal(result.capturedResponses.length, 1);
    assert.equal(result.capturedResponses[0].status, setup.status ?? 200);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    if (setup.body) assert.match(result.capturedResponses[0].error, /not JSON/);
  }
});

test('a spent budget or cancelled caller opens no browser', async () => {
  const signal = AbortSignal.abort();
  for (const extra of [{ maxTimeout: 1000 }, { signal }]) {
    const active = fixture(), result = await runJdDomestic({ ...active.options, ...extra });
    assert.equal(active.state.contexts, 0); assert.equal(result.capturedResponses[0].error, 'jd-domestic-budget');
  }
});

test('cancelling a pending navigation returns promptly and closes its context', async () => {
  const active = fixture(), abort = new AbortController();
  let release, entered;
  const begun = new Promise(resolve => { entered = resolve; });
  active.tab.goto = async () => { entered(); return new Promise(resolve => { release = () => resolve({ status: () => 200 }); }); };
  const lookup = runJdDomestic({ ...active.options, signal: abort.signal });
  await begun; abort.abort();
  const result = await Promise.race([lookup, new Promise(resolve => setTimeout(resolve, 150, null))]);
  release(); await lookup;
  assert.ok(result, 'Cancellation must not wait for the navigation timeout');
  assert.equal(active.state.closed, 1); assert.equal(active.state.requests, 0);
});

test('a context created after caller cancellation is closed without opening a page', async () => {
  const active = fixture(), abort = new AbortController();
  const original = active.options.handle.browser.newContext;
  let release, entered;
  const begun = new Promise(resolve => { entered = resolve; });
  active.options.handle.browser.newContext = () => {
    entered(); return new Promise(resolve => { release = async () => resolve(await original()); });
  };
  const lookup = runJdDomestic({ ...active.options, signal: abort.signal });
  await begun; abort.abort();
  const result = await Promise.race([lookup, new Promise(resolve => setTimeout(resolve, 150, null))]);
  await release(); await lookup; await new Promise(resolve => setImmediate(resolve));
  assert.ok(result); assert.equal(active.state.closed, 1);
  assert.equal(active.state.started, 0); assert.equal(active.state.requests, 0);
});


test('a visual abstention refreshes once in the same session and captures accepted history', async () => {
  const active = fixture({ plans: [null, { x: 30, y: 40 }], decline: 'ambiguous' });
  const result = await runJdDomestic({ ...active.options, maxTimeout: 40000 });
  assert.equal(active.state.plans, 2); assert.equal(active.state.refreshes, 1);
  assert.equal(active.state.started, 1); assert.equal(active.state.contexts, 1); assert.equal(active.state.closed, 1);
  assert.equal(active.state.clicks, 1); assert.equal(active.state.requests, 1);
  assert.equal(JSON.parse(result.capturedResponses[0].body).obj[0].rawWaybillCode, number);
  assert.deepEqual(active.state.captures[0].attempts, ['ambiguous', 'planned']);
  assert.equal(active.state.captures[0].puzzles, 2);
});

test('two visual abstentions stop after one refresh without submitting an answer', async () => {
  for (const decline of ['foreground', 'matching', 'ambiguous']) {
    const active = fixture({ plan: null, decline });
    const result = await runJdDomestic({ ...active.options, maxTimeout: 40000 });
    assert.equal(active.state.plans, 2); assert.equal(active.state.refreshes, 1);
    assert.equal(active.state.clicks, 0); assert.equal(active.state.requests, 0); assert.equal(active.state.closed, 1);
    assert.equal(result.capturedResponses[0].error, 'jd-domestic-unreadable');
  }
});

test('worker failures and insufficient headroom never refresh', async () => {
  for (const decline of ['capacity', 'cancelled', 'timeout', 'worker_error', 'input_or_budget', 'image', 'geometry', 'unreadable']) {
    const active = fixture({ plan: null, decline });
    await runJdDomestic({ ...active.options, maxTimeout: 40000 });
    assert.equal(active.state.plans, 1); assert.equal(active.state.refreshes, 0); assert.equal(active.state.closed, 1);
  }
  const active = fixture({ plan: null, decline: 'ambiguous' });
  await runJdDomestic({ ...active.options, maxTimeout: 13000 });
  assert.equal(active.state.plans, 1); assert.equal(active.state.refreshes, 0);
});

test('a session replacement during refresh prevents a second analysis or answer', async () => {
  const active = fixture({ plan: null, decline: 'ambiguous', refreshSession: true });
  const result = await runJdDomestic({ ...active.options, maxTimeout: 40000 });
  assert.equal(active.state.plans, 1); assert.equal(active.state.refreshes, 1); assert.equal(active.state.clicks, 0);
  assert.equal(result.capturedResponses[0].error, 'jd-domestic-guest_session_changed');
});

test('a stale generation cannot start a second analysis and cancellation closes promptly', async () => {
  const active = fixture({ plan: null, decline: 'ambiguous', refreshStale: true }), abort = new AbortController();
  const evaluate = active.tab.evaluate;
  let staleReads = 0;
  active.tab.evaluate = async fn => {
    if (fn === jdDisplayedPuzzle && active.state.refreshes && ++staleReads === 3) abort.abort();
    return evaluate(fn);
  };
  const result = await runJdDomestic({ ...active.options, maxTimeout: 40000, signal: abort.signal });
  assert.equal(active.state.plans, 1); assert.equal(active.state.refreshes, 1); assert.equal(active.state.clicks, 0);
  assert.equal(active.state.closed, 1); assert.equal(result.capturedResponses[0].error, 'jd-domestic-budget');
  assert.ok(result.durationMs < 1000);
});

test('a submitted answer is never refreshed after a tracking refusal', async () => {
  const active = fixture({ status: 403 });
  const result = await runJdDomestic({ ...active.options, maxTimeout: 40000 });
  assert.equal(result.capturedResponses[0].status, 403);
  assert.equal(active.state.plans, 1); assert.equal(active.state.refreshes, 0); assert.equal(active.state.clicks, 1);
});


test('an unchanged puzzle expires its refresh wait without a second analysis', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const active = fixture({ plan: null, decline: 'ambiguous', refreshStale: true });
  const evaluate = active.tab.evaluate;
  active.tab.evaluate = async fn => {
    const value = await evaluate(fn);
    if (fn === jdDisplayedPuzzle && active.state.refreshes) t.mock.timers.tick(5001);
    return value;
  };
  const result = await runJdDomestic({ ...active.options, maxTimeout: 40000 });
  assert.equal(result.capturedResponses[0].error, 'jd-domestic-stale_puzzle');
  assert.equal(active.state.plans, 1); assert.equal(active.state.refreshes, 1);
  assert.equal(active.state.clicks, 0); assert.equal(active.state.closed, 1);
});
