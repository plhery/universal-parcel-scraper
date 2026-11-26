import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dpdUkBrowserNumber, dpdUkRequestInfo, runDpdUkBrowser } from './dpd-uk-browser.mjs';

const number = '15500000000001';
const code = `${number}*12345`;
const api = 'https://apis.track.dpd.co.uk/v1/';
const url = `https://track.dpd.co.uk/?reference=${number}`;
const parcelPage = `https://track.dpd.co.uk/parcels/${code}`;
const capture = { captureResponses: [api] };
const urls = {
  reference: `${api}reference?origin=PRTK&postcode=&referenceNumber=${number}`,
  detail: `${api}parcels/${code}?_=1795218132355`,
  events: `${api}parcels/${code}/parcelevents`,
};
const bodies = {
  reference: JSON.stringify({ data: [{ parcelNumber: `${number}J`, parcelCode: code }] }),
  detail: JSON.stringify({ data: { parcelNumber: `${number}J`, parcelCode: code } }),
  events: JSON.stringify({ data: [{ eventText: 'Delivered' }] }),
};
const response = (kind, status = 200, overrides = {}) => ({
  url: () => urls[kind], status: () => status,
  request: () => ({ method: () => 'GET', url: () => urls[kind] }),
  headers: () => ({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'PRIVATE', 'retry-after': '60' }),
  body: async () => Buffer.from(bodies[kind]), ...overrides,
});
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function fixture() {
  const handlers = {};
  const state = { closed: 0, counted: 0, policy: 0, replacements: 0, navigated: 0, url: 'about:blank', targets: [] };
  const page = { on: (name, handler) => { handlers[name] = handler; }, off: name => { delete handlers[name]; }, url: () => state.url,
    // The search page reads the reference; the parcel route reads the detail and events.
    goto: async target => {
      state.navigated++;
      state.targets.push(target);
      state.url = target;
      if (target === url) handlers.response(response('reference'));
      else { await tick(); handlers.response(response('detail')); handlers.response(response('events')); }
    },
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const options = { url, capture, tier: 3, maxTimeout: 500,
    handle: { browser: { newContext: async () => context }, noteTemporaryContext: () => { state.counted++; }, requestBrowserReplacement: () => { state.replacements++; } },
    installPolicy: async () => { state.policy++; },
  };
  return { handlers, state, page, context, options };
}

test('DPD UK runner requires the exact tracker page and capture endpoint', () => {
  assert.equal(dpdUkBrowserNumber(url, capture), number);
  assert.equal(dpdUkBrowserNumber(url.replace(number, number.slice(4)), capture), number.slice(4));
  for (const candidate of [url + '#extra', url + '&extra=1', url.replace(number, number.slice(1)), url.replace(number, `${number}J`),
    url.replace('track.dpd.co.uk', 'example.test'), url.replace('track.dpd.co.uk', 'user@track.dpd.co.uk'), url.replace('/?', '/parcels?')]) {
    assert.equal(dpdUkBrowserNumber(candidate, capture), null);
  }
  assert.equal(dpdUkBrowserNumber(url, { captureResponses: [api, 'https://example.test'] }), null);
  assert.equal(dpdUkBrowserNumber(url, { captureResponses: ['https://apis.track.dpd.co.uk/'] }), null);
});

test('DPD UK requests are bound to the whole number and a syntactically valid code', () => {
  assert.deepEqual(dpdUkRequestInfo(urls.reference, number), { kind: 'reference' });
  assert.deepEqual(dpdUkRequestInfo(urls.detail, number), { kind: 'detail', code });
  assert.deepEqual(dpdUkRequestInfo(`${api}parcels/${encodeURIComponent(code)}`, number), { kind: 'detail', code });
  assert.deepEqual(dpdUkRequestInfo(urls.events, number), { kind: 'events', code });
  for (const other of [urls.reference.replace(number, number.slice(4)), `${urls.reference}&referenceNumber=${number}`,
    urls.reference.replace('postcode=', 'postcode=AB1'), urls.reference.replace('apis.track', 'example'),
    `${urls.detail}&other=1`, `${urls.events}?_=1`, `${api}parcels/a%20b`, `${api}parcels/${code}/other`, `${api}parcels/%E0`]) {
    assert.equal(dpdUkRequestInfo(other, number), null, other);
  }
});

test('captures the search, then the issued parcel\'s detail and events decoded, without cookies, and closes', async () => {
  const { handlers, state, options } = fixture();
  const result = await runDpdUkBrowser(options);
  assert.equal(result.status, 'success');
  assert.deepEqual(state.targets, [url, parcelPage]);
  assert.ok(result.body instanceof Uint8Array);
  assert.deepEqual(result.capturedResponses.map(entry => [entry.url, entry.status, entry.body]),
    ['reference', 'detail', 'events'].map(kind => [urls[kind], 200, bodies[kind]]));
  assert.ok(result.capturedResponses.every(entry => entry.trackingNumberSubmitted === number && !('kind' in entry) && !('code' in entry)));
  assert.deepEqual(result.capturedResponses[0].headers, { 'content-type': 'application/json', 'retry-after': '60' });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(state.closed, 1);
  assert.equal(state.policy, 1);
  assert.equal(state.counted, 1);
  assert.deepEqual(handlers, {});
});

test('opens the parcel whose whole number is the ten digits searched', async () => {
  const ten = '0000000003', tenCode = `${ten}*12345`, tenUrl = `https://track.dpd.co.uk/?reference=${ten}`;
  const tenUrls = { reference: `${api}reference?origin=PRTK&postcode=&referenceNumber=${ten}`,
    detail: `${api}parcels/${tenCode}`, events: `${api}parcels/${tenCode}/parcelevents` };
  const tenBodies = { reference: JSON.stringify({ data: [{ parcelNumber: '0000 000 003', parcelCode: tenCode, consignmentNumber: ten }] }),
    detail: JSON.stringify({ data: { parcelNumber: '0000 000 003', parcelCode: tenCode } }), events: bodies.events };
  const reply = kind => response(kind, 200, { url: () => tenUrls[kind], request: () => ({ method: () => 'GET', url: () => tenUrls[kind] }),
    body: async () => Buffer.from(tenBodies[kind]) });
  const { handlers, page, state, options } = fixture();
  page.goto = async target => {
    state.targets.push(target);
    state.url = target;
    if (target === tenUrl) handlers.response(reply('reference'));
    else { await tick(); handlers.response(reply('detail')); handlers.response(reply('events')); }
  };
  const result = await runDpdUkBrowser({ ...options, url: tenUrl });
  assert.equal(result.status, 'success');
  assert.deepEqual(state.targets, [tenUrl, `https://track.dpd.co.uk/parcels/${tenCode}`]);
  assert.deepEqual(result.capturedResponses.map(entry => entry.body), ['reference', 'detail', 'events'].map(kind => tenBodies[kind]));
});

test('leaves the parcel to the page once it opened it', async () => {
  const { handlers, page, state, options } = fixture();
  page.goto = async target => {
    state.targets.push(target);
    state.url = parcelPage;
    handlers.response(response('reference'));
    await tick();
    handlers.response(response('detail'));
    handlers.response(response('events'));
  };
  const result = await runDpdUkBrowser(options);
  assert.deepEqual(state.targets, [url]);
  assert.deepEqual(result.capturedResponses.map(entry => entry.url), [urls.reference, urls.detail, urls.events]);
});

test('drops a reply the search page was still reading when the parcel route opens', async () => {
  const { handlers, page, state, options } = fixture();
  const open = page.goto;
  page.goto = async target => {
    if (target !== url) return open(target);
    state.url = target;
    handlers.response(response('reference'));
    handlers.response(response('detail', 200, { body: async () => { await tick(); throw new Error('Navigated'); } }));
  };
  const result = await runDpdUkBrowser(options);
  assert.deepEqual(result.capturedResponses.map(entry => [entry.url, entry.error]), [[urls.reference, null], [urls.detail, null], [urls.events, null]]);
});

test('drops other numbers, other codes, other methods and redirected replies', async () => {
  const { handlers, page, options } = fixture();
  const other = `${api}parcels/15500000000002*1`;
  page.goto = async () => {
    handlers.response(response('reference', 403, { url: () => urls.reference.replace(number, '15500000000002'),
      request: () => ({ method: () => 'GET', url: () => urls.reference.replace(number, '15500000000002') }) }));
    handlers.response(response('reference', 403, { request: () => ({ method: () => 'POST', url: () => urls.reference }) }));
    handlers.response(response('reference', 403, { request: () => ({ method: () => 'GET', url: () => 'https://example.test/' }) }));
    handlers.response(response('reference'));
    await tick();
    handlers.response(response('detail', 403, { url: () => other, request: () => ({ method: () => 'GET', url: () => other }) }));
    handlers.response(response('detail'));
    handlers.response(response('events'));
  };
  const result = await runDpdUkBrowser(options);
  assert.deepEqual(result.capturedResponses.map(entry => entry.url), [urls.reference, urls.detail, urls.events]);
});

test('keeps a refusal that overtakes the search reply being read', async () => {
  const { handlers, page, options } = fixture();
  page.goto = async () => {
    handlers.response(response('reference', 200, { body: async () => { await tick(); await tick(); return Buffer.from(bodies.reference); } }));
    handlers.response(response('detail', 403, { body: async () => Buffer.from('<html>Forbidden</html>') }));
  };
  const result = await runDpdUkBrowser(options);
  assert.deepEqual(result.capturedResponses.map(entry => [entry.status, entry.body]),
    [[200, bodies.reference], [403, '<html>Forbidden</html>']]);
});

test('ends at a refusal, a limit, an unknown number or a list of parcels', async () => {
  const missing = JSON.stringify({ error: { statusCode: 404, error: 'Not Found', message: 'Your reference number could not be found' } });
  const several = JSON.stringify({ data: [{ parcelNumber: number, parcelCode: code }, { parcelNumber: number, parcelCode: `${code}9` }] });
  const refused = JSON.stringify({ error: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' } });
  for (const [status, body] of [[401, refused], [403, refused], [429, null], [503, null], [404, missing], [200, several]]) {
    const { handlers, page, state, options } = fixture();
    page.goto = async () => { handlers.response(response('reference', status, { body: async () => Buffer.from(body ?? 'unread') })); };
    const result = await runDpdUkBrowser({ ...options, maxTimeout: 2000 });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.capturedResponses.map(entry => [entry.status, entry.body]), [[status, body]]);
    assert.ok(result.durationMs < 1000);
    assert.equal(state.closed, 1);
  }
});

test('keeps what it saw at the deadline and bounds repeated replies', async () => {
  const waiting = fixture();
  waiting.page.goto = async () => { waiting.handlers.response(response('reference')); };
  const partial = await runDpdUkBrowser({ ...waiting.options, maxTimeout: 30 });
  assert.equal(partial.status, 'success');
  assert.equal(partial.capturedResponses.length, 1);
  const repeated = fixture();
  repeated.page.goto = async () => { for (let i = 0; i < 12; i++) repeated.handlers.response(response('reference', 200, { body: () => new Promise(() => {}) })); };
  const bounded = await runDpdUkBrowser({ ...repeated.options, maxTimeout: 30 });
  assert.equal(bounded.capturedResponses.length, 10);
  assert.ok(bounded.capturedResponses.at(-1).error);
});

test('rejects oversized replies before reading and after browser decompression', async () => {
  for (const declared of [true, false]) {
    const { handlers, page, options } = fixture();
    page.goto = async () => { handlers.response(response('reference', 200, {
      headers: () => ({ 'content-length': declared ? '1000001' : '20' }),
      body: async () => { assert.equal(declared, false); return Buffer.alloc(1000001); },
    })); };
    const result = await runDpdUkBrowser(options);
    assert.equal(result.capturedResponses[0].truncated, true);
    assert.equal(result.capturedResponses[0].body, null);
  }
});

test('cleans up hung navigation and late contexts, and fails without a reply', async () => {
  const { page, state, options } = fixture();
  page.goto = () => new Promise(() => {});
  const hung = await runDpdUkBrowser({ ...options, maxTimeout: 10 });
  assert.equal(hung.status, 'error');
  assert.match(hung.reason, /budget exhausted/);
  assert.equal(state.closed, 1);
  const late = fixture(); let release;
  late.options.handle.browser.newContext = () => new Promise(resolve => { release = resolve; });
  assert.equal((await runDpdUkBrowser({ ...late.options, maxTimeout: 5 })).status, 'error');
  release(late.context);
  await tick();
  assert.equal(late.state.closed, 1);
  assert.equal(late.state.navigated, 0);
  const aborted = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runDpdUkBrowser({ ...aborted.options, signal: controller.signal })).status, 'error');
  assert.equal(aborted.state.navigated, 0);
  assert.equal(await runDpdUkBrowser({ ...options, url: url + '&x=1' }), undefined);
});
