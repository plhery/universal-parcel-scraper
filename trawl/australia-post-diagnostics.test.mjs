import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./australia-post-browser.mjs', import.meta.url), 'utf8');
const importLine = "import { attachTrackingCapture, australiaPostClientKnown } from './tracking-capture.mjs';";
let generation = 0;
async function load(text, attach) {
  assert.equal(text.split(importLine).length, 2);
  globalThis.__auDiagnosticCapture = attach;
  try {
    return await import('data:text/javascript;base64,' + Buffer.from(text.replace(importLine,
      'const attachTrackingCapture = globalThis.__auDiagnosticCapture; const australiaPostClientKnown = () => false;') + `\n// fixture ${generation++}`).toString('base64'));
  } finally { delete globalThis.__auDiagnosticCapture; }
}
function fixture(fail, error = new Error('PRIVATE https://private.invalid/secret?token=secret proxy-user:password')) {
  const state = { closed: 0, drained: 0, opens: 0, counted: 0, policy: 0 };
  const hit = (phase, value) => { if (phase === fail) throw error; return value; };
  const evidence = { capturedResponses: [{ url: 'https://synthetic.invalid/capture', status: 200, body: '{"synthetic":true}' }] };
  const page = {
    goto: async () => hit('navigation', { status: () => hit('navigation_status', 200) }),
    content: async () => hit('page_content', '<html>synthetic</html>'),
    url: () => hit('effective_url', 'https://synthetic.invalid/'),
    evaluate: async () => hit('user_agent', 'synthetic-browser'),
    route: async () => hit('proxy_filter_installation'),
  };
  const context = { newPage: async () => hit('page_creation', page), close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => { state.opens++; return hit('context_creation', context); } },
    noteTemporaryContext: () => { state.counted++; hit('context_accounting'); } };
  const attach = async () => hit('capture_attachment', {
    prepare: async () => hit('capture_preparation'), settle: async () => hit('capture_settle'),
    drain: async () => { state.drained++; return hit('capture_drain', evidence); },
  });
  const options = { handle, url: 'https://synthetic.invalid/', tier: 3, maxTimeout: 1000,
    capture: {}, installPolicy: async () => { state.policy++; hit('policy_installation'); } };
  return { state, page, context, options, attach };
}

for (const failed of ['context_creation', 'context_accounting', 'page_creation', 'policy_installation',
  'capture_attachment', 'navigation', 'capture_preparation', 'capture_settle', 'capture_drain', 'page_content',
  'navigation_status', 'effective_url', 'user_agent']) {
  test(`safe reason identifies throwing ${failed} and preserves cleanup`, async () => {
    const f = fixture(failed);
    const { runAustraliaPostBrowser } = await load(source, f.attach);
    const result = await runAustraliaPostBrowser(f.options);
    const phase = ['navigation_status', 'effective_url', 'user_agent'].includes(failed) ? 'response_metadata' : failed;
    assert.equal(result.reason, `Australia Post browser retrieval failed (phase=${phase}; category=unknown)`);
    assert.deepEqual(result.diagnostic, { phase, category: 'unknown' });
    assert.equal(f.state.closed, failed === 'context_creation' ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private\.invalid|secret|password|proxy-user/);
  });
}

for (const [error, category] of [
  [Object.assign(new Error('private'), { name: 'TimeoutError' }), 'timeout'],
  [Object.assign(new Error('private'), { code: 'ETIMEDOUT' }), 'timeout'],
  [new Error('browser.newContext: Target page, context or browser has been closed private'), 'context_closed'],
  [new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at private'), 'proxy'],
  [Object.assign(new Error('private'), { code: 'ENOTFOUND' }), 'dns'],
  [new Error('page.goto: net::ERR_CONNECTION_RESET at private'), 'connection'],
  [Object.assign(new Error('private'), { code: 'CERT_HAS_EXPIRED' }), 'tls'],
  [Object.assign(new Error('private'), { name: 'AbortError' }), 'aborted'],
  [new Error('HTTP 500 private'), 'unknown'],
  ['private-string', 'unknown'],
  [{ get name() { throw new Error('private getter'); } }, 'unknown'],
]) {
  test(`allowlisted category ${category} returns no exception content`, async () => {
    const f = fixture('context_creation', error);
    const { runAustraliaPostBrowser } = await load(source, f.attach);
    const result = await runAustraliaPostBrowser(f.options);
    assert.equal(result.diagnostic.category, category);
    assert.match(result.reason, /^Australia Post browser retrieval failed \(phase=context_creation; category=[a-z_]+\)$/);
    assert.doesNotMatch(JSON.stringify(result), /private|500|ENOTFOUND|CERT_HAS_EXPIRED/);
  });
}

test('successful capture keeps its native result and omits failure diagnostics', async () => {
  const f = fixture();
  const { runAustraliaPostBrowser } = await load(source, f.attach);
  const result = await runAustraliaPostBrowser(f.options);
  const { durationMs, ...reply } = result;
  assert.equal(typeof durationMs, 'number');
  assert.deepEqual(reply, { tier: 3, status: 'success', html: '<html>synthetic</html>',
    statusCode: 200, effectiveUrl: 'https://synthetic.invalid/', cookies: [], userAgent: 'synthetic-browser',
    capturedResponses: [{ url: 'https://synthetic.invalid/capture', status: 200, body: '{"synthetic":true}' }] });
  assert.equal(f.state.closed, 1); assert.equal(f.state.counted, 1); assert.equal(f.state.policy, 1);
  assert.equal(Object.hasOwn(result, 'diagnostic'), false);
});

test('proxy filter installation has its own safe phase and closes the supplied context', async () => {
  const f = fixture('proxy_filter_installation');
  f.options.openContext = async () => f.context;
  f.options.filterProxied = true;
  const { runAustraliaPostBrowser } = await load(source, f.attach);
  const result = await runAustraliaPostBrowser(f.options);
  assert.equal(result.reason, 'Australia Post browser retrieval failed (phase=proxy_filter_installation; category=unknown)');
  assert.equal(f.state.closed, 1); assert.equal(f.state.policy, 1); assert.equal(f.state.counted, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private\.invalid|secret|password|proxy-user/);
});

test('deadline names its phase in the budget reason and late context closes once', async () => {
  const f = fixture(); let release;
  f.options.openContext = () => new Promise(resolve => { release = resolve; });
  f.options.maxTimeout = 5;
  const { runAustraliaPostBrowser } = await load(source, f.attach);
  const result = await runAustraliaPostBrowser(f.options);
  assert.equal(result.reason, 'Australia Post browser budget exhausted (phase=context_creation)');
  assert.deepEqual(result.diagnostic, { phase: 'context_creation', category: 'budget_exhausted' });
  release(f.context); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.state.closed, 1); assert.equal(f.state.policy, 0);
});

test('abort retains legacy reason and cleans a late injected context', async () => {
  const f = fixture(); const controller = new AbortController(); let release;
  f.options.signal = controller.signal;
  f.options.openContext = () => new Promise(resolve => { release = resolve; });
  const { runAustraliaPostBrowser } = await load(source, f.attach);
  const pending = runAustraliaPostBrowser(f.options); controller.abort(new Error('PRIVATE cancellation'));
  const result = await pending;
  assert.equal(result.reason, 'Australia Post browser budget exhausted (phase=context_creation)');
  assert.deepEqual(result.diagnostic, { phase: 'context_creation', category: 'aborted' });
  release(f.context); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.state.closed, 1); assert.equal(f.state.policy, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|cancellation/);
});

test('pre-abort and invalid budget remain non-opening', async () => {
  for (const mode of ['abort', 'budget']) {
    const f = fixture();
    if (mode === 'abort') { const c = new AbortController(); c.abort(); f.options.signal = c.signal; }
    else f.options.maxTimeout = 0;
    const { runAustraliaPostBrowser } = await load(source, f.attach);
    const result = await runAustraliaPostBrowser(f.options);
    assert.equal(result.reason, 'Australia Post browser budget exhausted (phase=validation)');
    assert.equal(result.diagnostic.phase, 'validation'); assert.equal(f.state.opens, 0);
  }
});

test('an accounting callback throwing after late creation still closes the context once', async () => {
  const f = fixture('context_accounting'); let release;
  f.options.handle.browser.newContext = () => new Promise(resolve => { release = resolve; });
  f.options.maxTimeout = 5;
  const { runAustraliaPostBrowser } = await load(source, f.attach);
  const result = await runAustraliaPostBrowser(f.options);
  assert.equal(result.reason, 'Australia Post browser budget exhausted (phase=context_creation)');
  assert.equal(f.state.closed, 0);
  release(f.context); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.state.counted, 1); assert.equal(f.state.closed, 1); assert.equal(f.state.policy, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private\.invalid|secret|password|proxy-user/);
});
