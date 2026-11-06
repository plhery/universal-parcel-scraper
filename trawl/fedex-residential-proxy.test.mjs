import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { LeaseKeeper, MAX_LEASE_BYTES, TunnelLease, createFedExResidentialProxy, fedexDestination, publicAddress, retryGateways, retryRoute } from './fedex-residential-proxy.mjs';

const resolve = async () => [{ address: '8.8.8.8', family: 4 }];
async function tunnel(proxy, authority, body = '') {
  return new Promise((done, reject) => {
    const url = new URL(proxy.url); let reply = '';
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', chunk => { reply += chunk.toString();
      if (reply.includes('\r\n\r\n') && body) { socket.write(body); body = ''; }
      if (reply.includes('pong')) socket.end();
    });
    socket.once('error', reject); socket.once('close', () => done(reply));
  });
}
test('only a host name on port 443 is a destination; the page and API are told apart', () => {
  assert.equal(fedexDestination('www.fedex.com:443').target, 'page');
  assert.equal(fedexDestination('API.fedex.com:443').target, 'api');
  assert.equal(fedexDestination('cdn.example.com:443').target, 'resource');
  for (const input of ['api.fedex.com:80', 'user@api.fedex.com:443', '127.0.0.1:443', '[::1]:443', 'api.fedex.com:443/', 'a..fedex.com:443']) {
    assert.throws(() => fedexDestination(input), undefined, input);
  }
});

test('private, mapped and special addresses cannot be proxy destinations', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '100.64.0.1', '224.0.0.1',
    '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('every connection uses the authenticated gateway; proof counts actual tunnels and bytes', async () => {
  const upstream = createServer(); const sockets = new Set(); const calls = [];
  upstream.on('connect', (req, socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    calls.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    socket.write('HTTP/1.1 200 OK\r\n\r\n'); socket.on('data', () => socket.end('pong'));
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done)); let totalBytes = 0;
  const proxy = await createFedExResidentialProxy('http://synthetic-user:synthetic-password@gateway.test:80', {
    resolve, requestHttp: options => request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }),
    onBytes: n => { totalBytes += n; },
  });
  try {
    assert.match(await tunnel(proxy, 'www.fedex.com:443', 'ping'), /pong/);
    assert.match(await tunnel(proxy, 'api.fedex.com:443', 'ping'), /pong/);
    assert.deepEqual(calls.map(c => c.target), ['www.fedex.com:443', 'api.fedex.com:443']);
    assert.ok(calls.every(c => c.auth === 'Basic ' + Buffer.from('synthetic-user:synthetic-password').toString('base64')));
    assert.deepEqual(proxy.proof(), { route: 'residential', family: 'unknown', pageConnections: 1, apiConnections: 1, connectionFailures: 0, bytes: 16 });
    assert.equal(totalBytes, 16);
  } finally { await proxy.close(); for (const socket of sockets) socket.destroy(); await new Promise(done => upstream.close(done)); }
});
test('gateway refusals and private destinations never get a direct fallback or accepted proof', async () => {
  let calls = 0;
  const upstream = createServer(); upstream.on('connect', (_req, socket) => socket.end('HTTP/1.1 407 Refused\r\n\r\n'));
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const proxy = await createFedExResidentialProxy('http://user:password@gateway.test', { resolve,
    requestHttp: options => { calls++; return request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }); } });
  try {
    assert.equal(await tunnel(proxy, 'api.fedex.com:443'), '');
    assert.equal(await tunnel(proxy, '127.0.0.1:443'), '');
    assert.equal(calls, 1); assert.equal(proxy.proof().apiConnections, 0);
    assert.equal(proxy.proof().connectionFailures, 2);
  } finally { await proxy.close(); await new Promise(done => upstream.close(done)); }
  await assert.rejects(createFedExResidentialProxy('http://user:password@gateway.test', { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }));
});
test('a refused tunnel reports the gateway status and its reason token', async () => {
  const replies = ['HTTP/1.1 502 Bad Gateway\r\nX-Webshare-Reason: target_connect_unknown_error\r\n\r\n',
    'HTTP/1.1 502 Bad Gateway\r\nX-Gateway-Reason: not a token\r\n\r\n'];
  const upstream = createServer(); upstream.on('connect', (_req, socket) => socket.end(replies.shift()));
  await new Promise(done => upstream.listen(0, '127.0.0.1', done)); const refusals = [];
  const proxy = await createFedExResidentialProxy('http://user:password@gateway.test', { resolve,
    requestHttp: options => request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }),
    onRefusal: refusal => refusals.push(refusal) });
  try {
    assert.equal(await tunnel(proxy, 'www.fedex.com:443'), '');
    assert.equal(await tunnel(proxy, 'cdn.example.com:443'), '');
    assert.equal(await tunnel(proxy, '127.0.0.1:443'), '');
    assert.deepEqual(refusals, [{ target: 'page', status: 502, reason: 'target_connect_unknown_error' },
      { target: 'resource', status: 502, reason: null }]);
    assert.equal(proxy.proof().pageConnections, 0);
  } finally { await proxy.close(); await new Promise(done => upstream.close(done)); }
});
test('a worker names one route and accepts several gateways without echoing them', async () => {
  assert.equal(retryRoute(undefined), 'residential');
  assert.equal(retryRoute(' datacenter '), 'datacenter');
  assert.throws(() => retryRoute('default'));
  assert.deepEqual(retryGateways('http://u:p@192.0.2.10:8000\nhttp://u:p@192.0.2.11:8001, http://u:p@192.0.2.12:8002'),
    ['http://u:p@192.0.2.10:8000', 'http://u:p@192.0.2.11:8001', 'http://u:p@192.0.2.12:8002']);
  for (const value of ['', ' ', 'http://u:secret@gateway.test/path', 'socks5://u:secret@gateway.test']) {
    try { retryGateways(value); assert.fail('accepted'); }
    catch (error) { assert.doesNotMatch(String(error), /secret/); }
  }
  // A gateway given by its address is checked like a resolved one, and the proof names the worker's route.
  const proxy = await createFedExResidentialProxy('http://u:p@8.8.4.4:8000', { route: 'datacenter',
    resolve: async host => [{ address: host, family: 4 }] });
  try { assert.equal(proxy.proof().route, 'datacenter'); } finally { await proxy.close(); }
  await assert.rejects(createFedExResidentialProxy('http://u:p@10.0.0.1:8000', { resolve: async host => [{ address: host, family: 4 }] }));
});

// A gateway whose tunnels answer each client chunk with `size` bytes, written in 16 KiB pieces as fast as the socket takes them.
async function streamingGateway(size) {
  const upstream = createServer(); const sockets = new Set(); let connects = 0, written = 0;
  upstream.on('connect', (_req, socket) => {
    connects++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.write('HTTP/1.1 200 OK\r\n\r\n');
    socket.once('data', () => {
      let left = size;
      const pump = () => { while (left > 0 && !socket.destroyed) { const n = Math.min(16_384, left); left -= n; written += n; if (!socket.write(Buffer.alloc(n, 1))) { socket.once('drain', pump); return; } } };
      pump();
    });
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  return { upstream, sockets, connects: () => connects, written: () => written,
    requestHttp: options => request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }),
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(done => upstream.close(done)); } };
}

// Opens a tunnel, sends one chunk and counts what comes back until the proxy or the timer closes it.
function download(proxy, authority, { untilMs = 2_000 } = {}) {
  return new Promise(done => {
    const url = new URL(proxy.url); let reply = Buffer.alloc(0), received = 0, headers = false;
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    const timer = setTimeout(() => socket.destroy(), untilMs);
    socket.on('data', chunk => {
      if (headers) { received += chunk.length; return; }
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf('\r\n\r\n');
      if (end < 0) return;
      headers = reply.subarray(0, end).toString(); received += reply.length - end - 4;
      if (/^HTTP\/1.1 200/.test(headers)) socket.write('ping');
    });
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); done({ status: headers ? Number(headers.split(' ')[1]) : 0, received }); });
  });
}

test('a lease is checked before its bytes are relayed and closes when a chunk would pass its allowance', () => {
  const lease = new TunnelLease({ id: 'lease-1', allowance: 100 });
  let dropped = 0; lease.track(() => { dropped++; });
  assert.equal(lease.take(60), true); assert.equal(lease.take(40), true);
  assert.equal(lease.take(1), false);
  assert.deepEqual({ bytes: lease.bytes, limited: lease.limited, open: lease.open, dropped }, { bytes: 101, limited: true, open: false, dropped: 1 });
  // A tunnel bound to a closed lease is torn down at once.
  lease.track(() => { dropped++; }); assert.equal(dropped, 2);
  for (const options of [{ id: 'a b', allowance: 1 }, { id: 'x', allowance: 0 }, { id: 'x', allowance: MAX_LEASE_BYTES + 1 }, { id: 'x', allowance: 1.5 }]) {
    assert.throws(() => new TunnelLease(options));
  }
});

test('without an open lease no tunnel reaches the gateway', async () => {
  const gateway = await streamingGateway(10); let current = null, unleased = 0;
  const proxy = await createFedExResidentialProxy('http://u:p@gateway.test', { resolve, requestHttp: gateway.requestHttp,
    lease: () => current, onUnleased: () => { unleased++; } });
  try {
    assert.equal((await download(proxy, 'www.fedex.com:443')).status, 503);
    current = new TunnelLease({ id: 'closed', allowance: 1_000 }); current.close();
    assert.equal((await download(proxy, 'www.fedex.com:443')).status, 503);
    assert.equal(gateway.connects(), 0); assert.equal(unleased, 2); assert.equal(proxy.proof().bytes, 0);
  } finally { await proxy.close(); await gateway.close(); }
});

test('a reply far larger than the allowance is cut: the lease never relays past it and reports the cut', async () => {
  // 15 MB from the gateway against a 1 MB allowance, below the old per-context limit.
  const gateway = await streamingGateway(15_000_000); let total = 0;
  const current = new TunnelLease({ id: 'near-cap', allowance: 1_000_000 });
  const proxy = await createFedExResidentialProxy('http://u:p@gateway.test', { resolve, requestHttp: gateway.requestHttp,
    lease: () => current, onBytes: n => { total += n; } });
  try {
    const { status, received } = await download(proxy, 'www.fedex.com:443', { untilMs: 5_000 });
    assert.equal(status, 200);
    assert.ok(received <= 1_000_000, `relayed ${received}`);
    assert.equal(current.limited, true); assert.equal(current.open, false);
    // The counted bytes, which include the chunk that crossed it, stay within one read of the allowance.
    assert.ok(current.bytes > 1_000_000 && current.bytes <= 1_000_000 + 65_536 * 2, `counted ${current.bytes}`);
    assert.equal(total, current.bytes);
    assert.ok(gateway.written() < 15_000_000);
    // The cut lease admits no further tunnel.
    assert.equal((await download(proxy, 'api.fedex.com:443')).status, 503);
    assert.equal(gateway.connects(), 1);
  } finally { await proxy.close(); await gateway.close(); }
});

test('closing the lease stops a tunnel that is still carrying traffic', async () => {
  const gateway = await streamingGateway(50_000_000);
  const current = new TunnelLease({ id: 'reply', allowance: MAX_LEASE_BYTES });
  const proxy = await createFedExResidentialProxy('http://u:p@gateway.test', { resolve, requestHttp: gateway.requestHttp, lease: () => current });
  try {
    const pending = download(proxy, 'www.fedex.com:443', { untilMs: 5_000 });
    while (current.bytes < 100_000) await new Promise(done => setTimeout(done, 5));
    current.close();
    const at = current.bytes;
    const { received } = await pending;
    await new Promise(done => setTimeout(done, 50));
    assert.equal(current.bytes, at);
    assert.ok(received <= at);
    assert.equal(current.limited, false);
    assert.equal(current.page, 1);
  } finally { await proxy.close(); await gateway.close(); }
});

test('the worker opens one lease at a time, uses each id once and closes it with the reply, a failure or its expiry', async () => {
  const keeper = new LeaseKeeper({ graceMs: 10 });
  assert.equal(keeper.issue({ byteAllowance: 0 }).status, 400);
  assert.equal(keeper.issue({ lease: 'bad id' }).status, 400);
  const { lease } = keeper.issue({ lease: 'attempt-1', byteAllowance: 1_000 });
  assert.equal(lease.allowance, 1_000);
  let during;
  await keeper.run(lease, 1_000, async current => { during = keeper.current; assert.equal(keeper.issue({ lease: 'other' }).status, 503); return current; });
  assert.equal(during, lease); assert.equal(keeper.current, null); assert.equal(lease.open, false);
  // A repeated request for the same reservation gets no second allowance.
  assert.equal(keeper.issue({ lease: 'attempt-1', byteAllowance: 1_000 }).status, 409);
  const failing = keeper.issue({ lease: 'attempt-2' }).lease;
  assert.equal(failing.allowance, MAX_LEASE_BYTES);
  await assert.rejects(keeper.run(failing, 1_000, async () => { throw new Error('lookup failed'); }));
  assert.equal(failing.open, false);
  // A lookup that outlives its budget loses its tunnels at the expiry, before it returns.
  const slow = keeper.issue({ lease: 'attempt-3' }).lease;
  let openAtExpiry;
  await keeper.run(slow, 5, async () => { await new Promise(done => setTimeout(done, 60)); openAtExpiry = slow.open; });
  assert.equal(openAtExpiry, false);
  assert.deepEqual(keeper.ends, { replied: 2, limited: 0, failed: 1 });
});
