import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withHelperContext } from './helper-context.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeBrowser({ close = async () => {}, newPage, contextDelay = 0 } = {}) {
  const log = [];
  const page = { id: 'page' };
  const context = {
    newPage: newPage ?? (async () => { log.push('page'); return page; }),
    close: async () => { log.push('close'); return close(); },
  };
  const handle = {
    browser: { newContext: async (...args) => { log.push(['context', args.length]); if (contextDelay) await wait(contextDelay); return context; } },
    noteTemporaryContext: () => log.push('counted'),
    requestBrowserReplacement: reason => log.push(['replace', reason]),
  };
  return { log, page, context, handle };
}

test('runs the steps on a counted fresh page and closes its context', async () => {
  const { log, page, context, handle } = fakeBrowser();
  const result = await withHelperContext({ handle, label: 'Test', timeoutMs: 1000,
    installPolicy: async target => { assert.equal(target, page); log.push('policy'); },
    onStop: run => { assert.equal(run.context, context); log.push('stop'); } },
  async run => { assert.equal(run.page, page); log.push('steps'); return 'ok'; });
  assert.equal(result, 'ok');
  assert.deepEqual(log, [['context', 0], 'counted', 'page', 'policy', 'steps', 'stop', 'close']);
});

test('a proxied context is opened by the caller and not counted', async () => {
  const { log, context, handle } = fakeBrowser();
  const result = await withHelperContext({ handle, label: 'Test', timeoutMs: 1000, openContext: async () => context },
    async () => 'ok');
  assert.equal(result, 'ok');
  assert.deepEqual(log, ['page', 'close']);
});

test('a close that hangs ends within the cleanup reserve and replaces the browser', async () => {
  const { log, handle } = fakeBrowser({ close: () => new Promise(() => {}) });
  const started = Date.now();
  const result = await withHelperContext({ handle, label: 'Test', timeoutMs: 1000, cleanupMs: 30 }, async () => 'ok');
  assert.equal(result, 'ok');
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(log.at(-1), ['replace', 'Test context cleanup failed']);
});

test('a deadline during the steps stops the run, reports it before cleanup and still closes', async () => {
  const { log, handle } = fakeBrowser();
  let expired = false;
  const result = await withHelperContext({ handle, label: 'Test', timeoutMs: 20,
    onExpire: kind => { expired = true; log.push(['expire', kind]); },
    onFailure: () => { log.push(['failure', expired]); return 'partial'; },
    onStop: () => log.push('stop') },
  () => new Promise(() => {}));
  assert.equal(result, 'partial');
  assert.deepEqual(log.slice(-4), [['expire', 'deadline'], ['failure', true], 'stop', 'close']);
});

test('the failure reply survives a close that fails', async () => {
  const { log, handle } = fakeBrowser({ close: async () => { throw new Error('closed already'); } });
  const phase = { value: 'setup' };
  const result = await withHelperContext({ handle, label: 'Test', timeoutMs: 1000,
    onFailure: error => ({ error: error.message, phase: phase.value }) },
  async () => { phase.value = 'navigation'; throw new Error('navigation failed'); });
  assert.deepEqual(result, { error: 'navigation failed', phase: 'navigation' });
  assert.deepEqual(log.at(-1), ['replace', 'Test context cleanup failed']);
});

test('an error without a failure hook reaches the caller after cleanup', async () => {
  const { log, handle } = fakeBrowser();
  await assert.rejects(withHelperContext({ handle, label: 'Test', timeoutMs: 1000 },
    async () => { throw new Error('steps failed'); }), /steps failed/);
  assert.equal(log.at(-1), 'close');
});

test('an abort stops the run with its reason and can close the context at once', async () => {
  const { log, handle } = fakeBrowser();
  const controller = new AbortController();
  const kinds = [];
  const running = withHelperContext({ handle, label: 'Test', timeoutMs: 1000, signal: controller.signal, closeOnAbort: true,
    onExpire: kind => kinds.push(kind) },
  async () => { controller.abort(new Error('cancelled')); await new Promise(() => {}); });
  await assert.rejects(running, /cancelled/);
  assert.deepEqual(kinds, ['abort']);
  // The abort closes the context; the final cleanup reuses that close.
  assert.equal(log.filter(entry => entry === 'close').length, 1);
});

test('an already aborted signal stops the run before its steps', async () => {
  const { handle } = fakeBrowser();
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let ran = false;
  await assert.rejects(withHelperContext({ handle, label: 'Test', timeoutMs: 1000, signal: controller.signal,
    check: () => controller.signal.throwIfAborted() }, async () => { ran = true; }), /cancelled/);
  assert.equal(ran, false);
});

test('a failed page creation still closes the context', async () => {
  const { log, handle } = fakeBrowser({ newPage: async () => { throw new Error('no page'); } });
  const result = await withHelperContext({ handle, label: 'Test', timeoutMs: 1000, onFailure: error => error.message },
    async () => 'unreachable');
  assert.equal(result, 'no page');
  assert.equal(log.at(-1), 'close');
});

test('a context arriving after the deadline is closed on arrival', async () => {
  const { log, handle } = fakeBrowser({ contextDelay: 40 });
  const result = await withHelperContext({ handle, label: 'Test', timeoutMs: 10, replaceOpening: true,
    onFailure: () => 'late' }, async () => 'unreachable');
  assert.equal(result, 'late');
  assert.deepEqual(log, [['context', 0], ['replace', 'Test context arrived after its deadline']]);
  await wait(60);
  assert.deepEqual(log.slice(2), ['counted', 'close']);
});

test('a setup check that fails stops before the steps and closes the context', async () => {
  const { log, handle } = fakeBrowser();
  let checks = 0;
  const result = await withHelperContext({ handle, label: 'Test', timeoutMs: 1000,
    check: () => { if (++checks === 3) throw new Error('budget'); }, onFailure: error => error.message },
  async () => 'unreachable');
  assert.equal(result, 'budget');
  assert.equal(log.at(-1), 'close');
});
