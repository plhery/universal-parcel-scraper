import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { flashCourierApi, flashCourierRequest, flashCourierResult, runFlashCourierGuest } from './flash-courier-guest.mjs';
const number = 'SYNTHETIC123', url = 'https://www.flashcourier.com.br/rastreio/' + number, capture = { captureResponses: [flashCourierApi(number)] };
const envelope = (extra = {}) => ({ protocol: 'flash-courier-guest-v1', requestedNumber: number, pageStatus: 200, phase: 'lookup', diagnostic: null,
  captures: [{ status: 200, reply: { kind: 'not_found', number } }], counts: { images: 1, submits: 1, ocr: 1 }, ...extra });
const options = { url, capture, tier: 3, maxTimeout: 2000 };
function fake(value, setup = () => {}) {
  return (executable, args, opts) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
    child.stdin.on('finish', () => { setup(executable, args, opts); setImmediate(() => { child.stdout.write(JSON.stringify(value)); child.emit('close', 0); }); });
    return child;
  };
}
test('dispatch is exact: origin, whole query, capture, session and solver policy', () => {
  assert.equal(flashCourierRequest(url, capture), number);
  for (const bad of [url + '?x=1', url + '/', url.replace('https:', 'http:'), url.replace('www.', ''), url + '#x', 'https://user@www.flashcourier.com.br/rastreio/' + number]) assert.equal(flashCourierRequest(bad, capture), null);
  for (const extra of [{ sessionContext: 'x' }, { solveEmbeddedCaptchas: false }, { captureResponses: [flashCourierApi(number), 'other'] }, { contentWaitForText: 'x' }]) assert.equal(flashCourierRequest(url, { ...capture, ...extra }), null);
});
test('projection keeps only safe fields and binds whole identity', () => {
  const r = flashCourierResult(envelope(), { number, url, tier: 3, durationMs: 10 });
  assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.deepEqual(JSON.parse(r.capturedResponses[0].body), { kind: 'not_found', number });
  assert.equal(JSON.parse(r.html).counts.images, 1);
  assert.throws(() => flashCourierResult(envelope({ requestedNumber: 'OTHER' }), { number, url, tier: 3 }));
  assert.throws(() => flashCourierResult(envelope({ captures: [{ status: 200, reply: { kind: 'not_found', number: 'OTHER' } }] }), { number, url, tier: 3 }));
});
test('late HTTP refusal is retained separately from earlier capture', () => {
  const r = flashCourierResult(envelope({ phase: 'generate', diagnostic: { kind: 'http', status: 429, retryAfter: '60', secret: 'HIDDEN' } }), { number, url, tier: 3 });
  assert.equal(JSON.parse(r.html).diagnostic.status, 429); assert.ok(!JSON.stringify(r).includes('HIDDEN'));
});
test('resolves worker against module and limits subprocess environment', async () => {
  const targets = [];
  const r = await runFlashCourierGuest({ ...options, validateTarget: async x => targets.push(x), spawnWorker: fake(envelope(), (exe, args, opts) => {
    assert.equal(exe, '/opt/zto-ocr/bin/python'); assert.ok(args[0].endsWith('/trawl/flash-courier-guest.py'));
    assert.deepEqual(Object.keys(opts.env).sort(), ['LANG', 'OMP_NUM_THREADS', 'PATH']);
  }) });
  assert.equal(r.capturedResponses.length, 1); assert.equal(targets.length, 3);
});
test('aborted requests and invalid scopes start no process', async () => {
  let calls = 0; const spawnWorker = () => { calls++; throw new Error('unexpected'); };
  await assert.rejects(runFlashCourierGuest({ ...options, signal: AbortSignal.abort(), spawnWorker }));
  assert.equal(await runFlashCourierGuest({ ...options, url: url + '2', spawnWorker }), undefined);
  assert.equal(calls, 0);
});
test('expired target validation starts no process', async () => {
  let calls = 0;
  const r = await runFlashCourierGuest({ ...options, maxTimeout: 40, validateTarget: () => new Promise(resolve => setTimeout(resolve, 10)), spawnWorker: () => { calls++; } });
  assert.equal(JSON.parse(r.html).diagnostic.kind, 'budget'); assert.equal(calls, 0);
});
test('malformed worker output stays schema and never becomes absence', async () => {
  const r = await runFlashCourierGuest({ ...options, spawnWorker: fake({ kind: 'not_found' }) });
  assert.equal(JSON.parse(r.html).diagnostic.kind, 'schema');
});
test('real owned subprocess is killed on cancellation and budget', async () => {
  for (const cancel of [false, true]) {
    let child;
    const ctl = new AbortController();
    const pending = runFlashCourierGuest({ ...options, maxTimeout: 100, signal: ctl.signal, spawnWorker: () => {
      child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'] }); return child;
    } });
    if (cancel) setTimeout(() => ctl.abort(), 20);
    if (cancel) await assert.rejects(pending); else assert.equal(JSON.parse((await pending).html).diagnostic.kind, 'budget');
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(child.pid, 0));
  }
});
test('Python contract suite has no carrier or model egress', () => {
  return new Promise((resolve, reject) => {
    const code = `import runpy,socket,ssl,urllib.request;socket.socket=lambda *a,**k:(_ for _ in ()).throw(RuntimeError('unexpected_egress'));runpy.run_path(${JSON.stringify(new URL('./flash-courier-guest.test.py', import.meta.url).pathname)},run_name='__main__')`;
    const child = spawn('python3', ['-B', '-c', code], { stdio: 'pipe' }); let output = ''; child.stderr.on('data', p => { output += p; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(output)));
  });
});
test('both tiers dispatch before opening a browser and Docker includes relative assets', () => {
  const install = readFileSync(new URL('./install.mjs', import.meta.url), 'utf8'), docker = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
  assert.ok(install.includes('if (carrierPage && flashCourierRequest(url, capture))'));
  assert.ok(install.includes('signal: budget.signal, validateTarget: validateOutboundUrl ? address => budget.run(() => validateOutboundUrl(address)) : undefined'));
  for (const f of ['flash-courier-guest.mjs', 'flash-courier-guest.py']) assert.ok(docker.includes(`COPY ${f} /app/packages/tiers/src/utils/${f}`));
});

// Execute the installer's actual dispatch expression: the service's validator is optional.
test('tier dispatch accepts an absent validator and preserves supplied policy and budget', async () => {
  const install = readFileSync(new URL('./install.mjs', import.meta.url), 'utf8');
  const expression = /if \(carrierPage && flashCourierRequest\(url, capture\)\) return await ([^\n]+)/.exec(install)?.[1];
  assert.ok(expression);
  const dispatch = new Function('runFlashCourierGuest', 'carrierRun', 'budget', 'validateOutboundUrl', `return ${expression}`);
  for (const tier of [2, 3]) {
    const targets = []; let budgetCalls = 0;
    const budget = { signal: new AbortController().signal, async run(fn) { budgetCalls++; return fn(); } };
    const run = async opts => {
      assert.equal(opts.signal, budget.signal); assert.equal(opts.tier, tier);
      return runFlashCourierGuest({ ...opts, spawnWorker: fake(envelope()) });
    };
    const absent = await dispatch(run, { ...options, tier }, budget, undefined);
    assert.equal(absent.capturedResponses.length, 1); assert.equal(budgetCalls, 0);
    const present = await dispatch(run, { ...options, tier }, budget, async address => { targets.push(address); });
    assert.equal(present.capturedResponses.length, 1);
    assert.deepEqual(targets, [url, 'https://www.flashcourier.com.br/api/captcha/generate/', flashCourierApi(number)]);
    assert.equal(budgetCalls, 3);
    let spawns = 0;
    const blocked = async opts => runFlashCourierGuest({ ...opts, spawnWorker: () => { spawns++; } });
    await assert.rejects(dispatch(blocked, { ...options, tier }, budget, async () => { throw new Error('policy_refusal'); }), /policy_refusal/);
    assert.equal(spawns, 0);
    const ended = { ...budget, async run() { throw new Error('deadline'); } };
    await assert.rejects(dispatch(blocked, { ...options, tier }, ended, async () => {}), /deadline/);
    assert.equal(spawns, 0);
  }
});
