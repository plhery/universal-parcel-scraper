import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FEDEX_WARMUP_ATTEMPTS, fedexWarmupRequest, warmFedExSession } from './fedex-warmup.mjs';

// Synthetic: twelve digits in FedEx's shape, not a shipment.
const NUMBER = '123456789012';

// A clock that the lookups and pauses move forward, so the limits are checked without waiting.
function harness({ verifyOn = Infinity, busyFirst = 0, peerAnswers = () => true } = {}) {
  let clock = 0, lookups = 0, busy = busyFirst, verified = false, peerChecks = 0;
  const events = [], asked = [];
  return {
    events, asked,
    get lookups() { return lookups; },
    options: {
      number: NUMBER, now: () => clock, sleep: async ms => { clock += ms; }, report: fields => events.push(fields),
      peer: async () => peerAnswers(peerChecks++),
      verified: () => verified,
      lookup: async req => {
        if (busy > 0) { busy--; return { status: 503, busy: true }; }
        asked.push(req); lookups++; clock += 30_000;
        if (lookups >= verifyOn) verified = true;
        return { status: 200 };
      },
    },
  };
}

test('the warm-up asks for the lookup the FedEx adapter sends the worker', () => {
  assert.deepEqual(fedexWarmupRequest(` ${NUMBER} `), { url: `https://www.fedex.com/fedextrack/?trknbr=${NUMBER}`,
    skipHttp: true, maxTier: 3, maxTimeout: 40_000, captureResponses: ['https://api.fedex.com/track/v2/shipments'] });
  assert.equal(fedexWarmupRequest('12345'), null);
  assert.equal(fedexWarmupRequest(undefined), null);
});

test('while another worker serves, the port waits for a verified session', async () => {
  const h = harness({ verifyOn: 2 });
  const result = await warmFedExSession(h.options);
  assert.equal(result.held, true);
  assert.equal(h.lookups, 2);
  assert.deepEqual(h.events.map(event => event.state), ['started', 'ready']);
  assert.equal(h.events.at(-1).attempts, 2);
});

test('the port opens once the attempts are spent, so a refusing FedEx never keeps it closed', async () => {
  const h = harness();
  await warmFedExSession(h.options);
  assert.equal(h.lookups, FEDEX_WARMUP_ATTEMPTS);
  assert.deepEqual(h.events.map(event => event.state), ['started', 'gave_up']);
});

test('no lookup starts without time for FedEx to answer, and the last one gets only the time left', async () => {
  const h = harness();
  await warmFedExSession({ ...h.options, limitMs: 50_000 });
  // 30 s for the first lookup, 5 s of pause: 15 s are left, enough for a second, bounded to them.
  assert.deepEqual(h.asked.map(req => req.maxTimeout), [40_000, 15_000]);
  assert.equal(h.events.at(-1).state, 'gave_up');
});

test('the port opens as soon as the other worker stops answering', async () => {
  const h = harness({ peerAnswers: check => check === 0 });
  await warmFedExSession(h.options);
  assert.equal(h.lookups, 1);
  assert.deepEqual(h.events.map(event => event.state), ['started', 'peer_gone']);
});

test('alone, the port opens at once and the session is prepared beside the worker\'s own lookups', async () => {
  const h = harness({ verifyOn: 1, busyFirst: 2, peerAnswers: () => false });
  const result = await warmFedExSession(h.options);
  assert.equal(result.held, false);
  assert.deepEqual(h.events.map(event => event.state), ['not_held']);
  await result.done;
  // Two answers that every browser was busy did not count as attempts.
  assert.equal(h.lookups, 1);
  assert.deepEqual(h.events.map(event => event.state), ['not_held', 'ready']);
  assert.equal(h.events.at(-1).held, false);
});

test('a session a caller\'s lookup verified ends the warm-up, and so does a shutdown', async () => {
  const verified = harness();
  await warmFedExSession({ ...verified.options, verified: () => true });
  assert.equal(verified.lookups, 0);
  assert.equal(verified.events.at(-1).state, 'ready');
  const stopping = harness({ peerAnswers: () => false });
  let stopped = false;
  const result = await warmFedExSession({ ...stopping.options, stopped: () => stopped,
    lookup: async () => { stopped = true; return { status: 503, busy: true }; } });
  await result.done;
  assert.equal(stopping.events.at(-1).state, 'stopped');
});

test('a number the worker would refuse skips the warm-up, and failing diagnostics or lookups never hold the port', async () => {
  const skipped = harness();
  assert.equal((await warmFedExSession({ ...skipped.options, number: '42' })).held, false);
  assert.deepEqual(skipped.events, [{ state: 'skipped', reason: 'invalid_number' }]);
  const failing = harness();
  const result = await warmFedExSession({ ...failing.options, report: () => { throw new Error('log'); },
    lookup: async () => { throw new Error('browser'); }, peer: async () => { throw new Error('dns'); } });
  assert.equal(result.held, false);
  await result.done;
});

test('the retry worker\'s image carries every module its server imports', () => {
  const render = readFileSync(new URL('render-fedex-retry.mjs', import.meta.url), 'utf8');
  const files = JSON.parse(render.match(/const files = (\[[^\]]+\]);/)[1].replaceAll("'", '"'));
  const seen = new Set();
  const visit = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    for (const [, imported] of source.matchAll(/from '\.\/([^']+)'/g)) visit(imported);
  };
  visit('fedex-retry-server.mjs');
  assert.deepEqual([...seen].sort(), [...files].sort());
});
