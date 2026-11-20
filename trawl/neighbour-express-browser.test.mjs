import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neighbourPageUrl, neighbourLookupUrl, neighbourBrowserNumber, boundNeighbourLookup,
  projectNeighbourReply, runNeighbourBrowser, NEIGHBOUR_CAPTURE_BYTES } from './neighbour-express-browser.mjs';

const number = 'NR746193820571', other = 'NR746193820572', frame = {};
const url = neighbourPageUrl(number), api = neighbourLookupUrl(number), capture = { captureResponses: [api] };
const payload = { code: '0', msg: 'PRIVATE', data: { recipient: 'PRIVATE', results: [{ trackno: number, status: 'success',
  address: 'PRIVATE', data: [{ status: 10, statusText: 'Delivered', time: '2026-01-20 10:19:14', timezone: 'UTC-05:00',
    contact: 'PRIVATE', note: 'PRIVATE', signature: 'PRIVATE' }] }] } };
const request = (n = number, extra = {}) => ({ url: () => neighbourLookupUrl(n), method: () => 'POST',
  postData: () => null, headers: () => ({ 'x-recaptcha-token': 'PRIVATE' }), frame: () => frame, ...extra });

function fixture({ text = JSON.stringify(payload), status = 200, headers = {}, timeout = 1000, respond = true, network = false, body, deferredResponse = false, pageAddress = url } = {}) {
  const listeners = new Map(), state = { closed: 0, allowed: 0, blocked: 0, policy: 0, bodyReads: 0 };
  let route;
  const emit = async (event, value) => { for (const f of listeners.get(event) ?? []) await f(value); };
  const page = { mainFrame: () => frame, url: () => pageAddress,
    on: (event, f) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(f); },
    off: (event, f) => listeners.get(event)?.delete(f),
    route: async (pattern, f) => { assert.ok(pattern.test(api)); assert.ok(pattern.test(api.replace('batchTrackByTrackno', 'batchTrackByTracknoCaptcha'))); route = f; },
    goto: async () => {
      if (respond) setTimeout(async () => {
        const forwarded = [];
        for (const r of [request(other), request(), request()]) {
          let allowed = false;
          await route({ request: () => r, fallback: async () => { state.allowed++; allowed = true; }, abort: async () => { state.blocked++; } });
          if (!allowed) { if (deferredResponse) await emit('requestfailed', r); continue; }
          if (deferredResponse) { forwarded.push(r); continue; }
          if (network) await emit('requestfailed', r);
          else await emit('response', { request: () => r, status: () => status,
            headers: () => ({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'PRIVATE', ...headers }),
            body: async () => { state.bodyReads++; return body ? await body() : Buffer.from(text); } });
        }
        for (const r of forwarded) await emit('response', { request: () => r, status: () => status,
          headers: () => ({ 'content-type': 'application/json' }), body: async () => Buffer.from(text) });
      }, 2);
      return { status: () => 200 };
    }, bringToFront: async () => {},
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async options => { state.contextOptions = options; return context; } }, noteTemporaryContext: () => {}, requestBrowserReplacement: () => {} };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, listeners };
}

test('accepts only the canonical return page and one whole-number API capture', () => {
  assert.equal(neighbourBrowserNumber(url, capture), number);
  const second = 'N1234R567891'; assert.equal(neighbourBrowserNumber(neighbourPageUrl(second), { captureResponses: [neighbourLookupUrl(second)] }), second);
  for (const address of [url.replace('https:', 'http:'), url.replace('neighbourexpress.com', 'other.test'), url + '#x', url + '&x=1',
    url + '&no=' + number, url.replace('/track?', '/track/?'), neighbourPageUrl('OTHER1234'), neighbourPageUrl(number.toLowerCase())]) {
    assert.equal(neighbourBrowserNumber(address, capture), null);
  }
  for (const values of [[api, api], [api.replace(number, other)], [api.split('?')[0]]])
    assert.equal(neighbourBrowserNumber(url, { captureResponses: values }), null);
});

test('binds method, empty body, whole query, frame and absence of account authorization', () => {
  assert.equal(boundNeighbourLookup(request(), number, { mainFrame: () => frame }), true);
  for (const r of [request(other), request(number, { method: () => 'GET' }), request(number, { postData: () => 'x=1' }),
    request(number, { headers: () => ({ Authorization: 'PRIVATE' }) }), request(number, { frame: () => ({}) }),
    request(number, { url: () => api + '&x=1' }), request(number, { url: () => api.replace('batchTrackByTrackno', 'batchTrackByTracknoCaptcha') })])
    assert.equal(boundNeighbourLookup(r, number, { mainFrame: () => frame }), false);
});

test('projects only operational identity, codes, descriptions and clocks', () => {
  const out = JSON.parse(projectNeighbourReply(payload)); assert.equal(JSON.stringify(out).includes('PRIVATE'), false);
  assert.deepEqual(out.data.results[0].data[0], { status: 10, statusText: 'Delivered', time: '2026-01-20 10:19:14', timezone: 'UTC-05:00' });
  assert.deepEqual(JSON.parse(projectNeighbourReply({ code: '1', data: 0, token: 'PRIVATE' })), { code: '1', data: 0 });
  for (const x of [null, [], 'PRIVATE']) assert.equal(projectNeighbourReply(x), 'null');
});

test('keeps multiplicity, oversized histories and changed types visible', () => {
  const p = structuredClone(payload); p.data.results = Array.from({ length: 20 }, () => p.data.results[0]);
  assert.equal(JSON.parse(projectNeighbourReply(p)).data.results.length, 3);
  const one = structuredClone(payload); one.data.results[0].data = Array.from({ length: 500 }, () => one.data.results[0].data[0]);
  assert.equal(JSON.parse(projectNeighbourReply(one)).data.results[0].data.length, 301);
  one.data.results[0].data = ['PRIVATE']; assert.deepEqual(JSON.parse(projectNeighbourReply(one)).data.results[0].data, [null]);
  assert.equal(JSON.parse(projectNeighbourReply({ code: '0', data: { results: 'PRIVATE' } })).data.results, null);
});

test('reads the decoded gzip response, aborts other or repeated lookups and closes its context', async () => {
  const f = fixture(); const result = await runNeighbourBrowser(f.options);
  assert.equal(result.reason, 'neighbour-reply'); assert.equal(result.capturedResponses.length, 1);
  assert.equal(result.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(result.capturedResponses[0].url, api); assert.equal(result.html, ''); assert.deepEqual(result.cookies, []);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(f.state.allowed, 1);
  assert.ok(f.state.blocked >= 1); assert.equal(f.state.closed, 1); assert.equal(f.state.policy, 1);
  assert.deepEqual(f.state.contextOptions, { locale: 'en-CA' });
  assert.equal([...f.listeners.values()].reduce((n, x) => n + x.size, 0), 0);
});

test('keeps a verification reply for the adapter instead of treating it as missing', async () => {
  const f = fixture({ text: '{"code":"1","data":0}' }); const result = await runNeighbourBrowser(f.options);
  assert.deepEqual(JSON.parse(result.capturedResponses[0].body), { code: '1', data: 0 }); assert.equal(f.state.closed, 1);
});

test('reports the page address actually reached for the adapter to validate', async () => {
  const moved = url + '#changed', f = fixture({ pageAddress: moved });
  assert.equal((await runNeighbourBrowser(f.options)).effectiveUrl, moved);
});

test('an aborted duplicate cannot settle or replace the allowed request still in flight', async () => {
  const f = fixture({ deferredResponse: true }); const result = await runNeighbourBrowser(f.options);
  assert.equal(result.capturedResponses.length, 1); assert.equal(result.capturedResponses[0].status, 200);
  assert.equal(JSON.parse(result.capturedResponses[0].body).data.results[0].trackno, number);
  assert.equal(f.state.allowed, 1); assert.equal(f.state.blocked, 2); assert.equal(f.state.closed, 1);
});

test('retains HTTP refusals and only retry headers without attempting to read their bodies', async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const f = fixture({ status, headers: { 'retry-after': '120' } }); const result = await runNeighbourBrowser(f.options);
    assert.equal(result.capturedResponses[0].status, status);
    assert.deepEqual(result.capturedResponses[0].headers, { 'retry-after': '120' }); assert.equal(f.state.bodyReads, 0);
  }
});

test('keeps malformed JSON, challenge HTML and oversized bodies distinct', async () => {
  for (const [options, flag] of [[{ text: 'bad json' }, 'invalid-json'], [{ text: '<title>Just a moment</title>' }, 'challenge-html'],
    [{ body: async () => { throw Error('PRIVATE'); } }, 'body-read']]) {
    const f = fixture(options); const result = await runNeighbourBrowser(f.options);
    assert.equal(result.capturedResponses[0].error, flag); assert.equal(f.state.closed, 1);
  }
  for (const options of [{ headers: { 'content-length': String(NEIGHBOUR_CAPTURE_BYTES + 1) } }, { text: 'x'.repeat(NEIGHBOUR_CAPTURE_BYTES + 1) }]) {
    const f = fixture(options); const result = await runNeighbourBrowser(f.options); assert.equal(result.capturedResponses[0].truncated, true);
  }
});

test('preserves transport failure and unfinished verification as separate outcomes', async () => {
  const network = fixture({ network: true }); assert.equal((await runNeighbourBrowser(network.options)).reason, 'neighbour-network');
  const missing = fixture({ respond: false, timeout: 40 }); assert.equal((await runNeighbourBrowser(missing.options)).reason, 'neighbour-capture_missing');
  assert.equal(network.state.closed, 1); assert.equal(missing.state.closed, 1);
});

test('cancellation closes an opened context and a pre-aborted call does no work', async () => {
  const f = fixture({ respond: false }); const c = new AbortController();
  const run = runNeighbourBrowser({ ...f.options, signal: c.signal }); setTimeout(() => c.abort(), 5);
  await assert.rejects(run, { name: 'AbortError' }); assert.equal(f.state.closed, 1);
  const next = fixture(); await assert.rejects(runNeighbourBrowser({ ...next.options, signal: c.signal }), { name: 'AbortError' });
  assert.equal(next.state.closed, 0);
});
