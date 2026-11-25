import assert from 'node:assert/strict';
import { test } from 'node:test';
import { warmupPeerServing } from './warmup-peer.mjs';

test('another container serves when an address other than its own answers its health check', async () => {
  const lookup = async (host, options) => {
    assert.deepEqual([host, options], ['flaresolverr', { all: true }]);
    return [{ address: '10.0.1.5', family: 4 }, { address: '10.0.1.9', family: 4 }];
  };
  const interfaces = () => ({ lo: [{ address: '127.0.0.1' }], eth0: [{ address: '10.0.1.5' }] });
  const asked = [];
  const answer = status => async url => { asked.push(url); return new Response('{}', { status }); };
  assert.equal(await warmupPeerServing('flaresolverr', 8191, { lookup, interfaces, fetcher: answer(200) }), true);
  assert.deepEqual(asked, ['http://10.0.1.9:8191/health']);
  assert.equal(await warmupPeerServing('flaresolverr', 8191, { lookup, interfaces, fetcher: answer(503) }), false);
  assert.equal(await warmupPeerServing('flaresolverr', 8191, { lookup, interfaces, fetcher: async () => { throw new Error('ECONNREFUSED'); } }), false);
  assert.equal(await warmupPeerServing('flaresolverr', 8191, { lookup: async () => { throw new Error('ENOTFOUND'); }, interfaces }), false);
  const alone = async () => [{ address: '10.0.1.5', family: 4 }];
  assert.equal(await warmupPeerServing('flaresolverr', 8191, { lookup: alone, interfaces, fetcher: answer(200) }), false);
  asked.length = 0;
  await warmupPeerServing('flaresolverr', 8191, { lookup: async () => [{ address: 'fd00::9', family: 6 }], interfaces, fetcher: answer(200) });
  assert.deepEqual(asked, ['http://[fd00::9]:8191/health']);
});
