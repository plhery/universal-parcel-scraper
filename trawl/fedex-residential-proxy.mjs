import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const private4 = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) private4.addSubnet(ip, prefix, 'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const special6 = new BlockList();
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) special6.addSubnet(ip, prefix, 'ipv6');

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !private4.check(address, 'ipv4')
    : family === 6 && global6.check(address, 'ipv6') && !special6.check(address, 'ipv6');
}

/** A browser's CONNECT authority: a host name on port 443, and whether it is FedEx's page or tracking API. */
export function fedexDestination(authority) {
  const match = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):443$/i.exec(authority ?? '');
  if (!match || match[1].includes('..') || isIP(match[1])) throw new Error('Invalid proxy destination');
  const host = match[1].toLowerCase();
  return { host, target: host === 'www.fedex.com' ? 'page' : host === 'api.fedex.com' ? 'api' : 'resource' };
}

/** A gateway names why it refused a tunnel in a header such as `x-webshare-reason`; only a plain token is kept. */
function refusalReason(headers) {
  for (const [name, value] of Object.entries(headers)) {
    if (/^x-[a-z0-9-]+-reason$/.test(name) && typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)) return value;
  }
  return null;
}

export const RETRY_ROUTES = ['residential', 'datacenter'];

/** The worker's route, `residential` unless `FEDEX_RETRY_ROUTE` names another. */
export function retryRoute(value) {
  const route = value?.trim() || 'residential';
  if (!RETRY_ROUTES.includes(route)) throw new Error('FEDEX_RETRY_ROUTE must be residential or datacenter');
  return route;
}

/** The gateways, separated by white space or commas; values never appear in errors. */
export function retryGateways(value) {
  const gateways = (value ?? '').split(/[\s,]+/).filter(Boolean);
  if (!gateways.length) throw new Error('Set FEDEX_RETRY_PROXY_URL to the proxy gateway');
  for (const gateway of gateways) gatewayUrl(gateway);
  return gateways;
}

function gatewayUrl(value) {
  let gateway;
  try { gateway = new URL(value); } catch { throw new Error('Invalid proxy gateway'); }
  if (!['http:', 'https:'].includes(gateway.protocol) || !gateway.hostname || gateway.search || gateway.hash
    || !['', '/'].includes(gateway.pathname)) throw new Error('Invalid proxy gateway');
  return gateway;
}

/** The most a lookup's lease may carry, and what a request that names none gets. */
export const MAX_LEASE_BYTES = 64 * 1024 * 1024;

/**
 * One lookup's permission to use the gateway: every tunnel opens under the
 * lease of the lookup that is running, counts each chunk it receives against
 * the lease's allowance before relaying it, and is destroyed when the lease
 * closes. A chunk that would carry the lease past its allowance is counted,
 * never relayed, and closes the lease.
 */
export class TunnelLease {
  #drops = new Set();
  constructor({ id, allowance }) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('Invalid lease');
    if (!Number.isSafeInteger(allowance) || allowance < 1 || allowance > MAX_LEASE_BYTES) throw new Error('Invalid lease allowance');
    this.id = id; this.allowance = allowance;
    this.bytes = 0; this.page = 0; this.api = 0; this.failures = 0;
    this.open = true; this.limited = false;
  }

  /** Registers a tunnel's teardown; returns its removal. */
  track(drop) {
    if (!this.open) { drop(); return () => {}; }
    this.#drops.add(drop);
    return () => this.#drops.delete(drop);
  }

  /** Counts received bytes; false once the lease is closed or past its allowance. */
  take(bytes) {
    if (!this.open) return false;
    this.bytes += bytes;
    if (this.bytes <= this.allowance) return true;
    this.limited = true; this.close();
    return false;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    for (const drop of this.#drops) drop();
    this.#drops.clear();
  }
}

/**
 * The worker's leases: at most one open, each id used once, and each closed when its
 * lookup ends or, whatever the lookup does, `graceMs` after its budget.
 */
export class LeaseKeeper {
  #used = new Set();
  constructor({ graceMs = 2_000, remember = 10_000 } = {}) {
    this.graceMs = graceMs; this.remember = remember;
    this.current = null;
    this.ends = { replied: 0, limited: 0, failed: 0 };
  }

  /** A new lease for a request, or the HTTP status that refuses it. */
  issue({ lease, byteAllowance } = {}) {
    let next;
    try { next = new TunnelLease({ id: lease ?? crypto.randomUUID(), allowance: byteAllowance ?? MAX_LEASE_BYTES }); }
    catch { return { status: 400 }; }
    if (this.current?.open) return { status: 503 };
    if (this.#used.has(next.id)) return { status: 409 };
    this.#used.add(next.id);
    if (this.#used.size > this.remember) this.#used.delete(this.#used.values().next().value);
    return { lease: next };
  }

  /** Runs a lookup under its lease; its tunnels are closed before the lookup's answer is used. */
  async run(lease, budgetMs, work) {
    this.current = lease;
    const expiry = setTimeout(() => lease.close(), Math.max(0, budgetMs) + this.graceMs);
    try {
      const result = await work(lease);
      lease.close();
      this.ends[lease.limited ? 'limited' : 'replied']++;
      return result;
    } catch (error) { lease.close(); this.ends.failed++; throw error; }
    finally { clearTimeout(expiry); lease.close(); if (this.current === lease) this.current = null; }
  }
}

/**
 * Every TLS connection goes through the configured authenticated gateway; no direct fallback.
 * With `lease`, a tunnel opens only while it returns an open `TunnelLease` and is bound to it.
 */
export async function createFedExResidentialProxy(value, { resolve = lookup, requestHttp = httpRequest,
  requestHttps = httpsRequest, onBytes = () => {}, onRefusal = () => {}, onUnleased = () => {}, route = 'residential', lease: currentLease } = {}) {
  const gateway = gatewayUrl(value);
  let authorization;
  try { authorization = 'Basic ' + Buffer.from(decodeURIComponent(gateway.username) + ':' + decodeURIComponent(gateway.password)).toString('base64'); }
  catch { throw new Error('Invalid proxy gateway credentials'); }
  const peers = await resolve(gateway.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!peers.length || peers.some(peer => !publicAddress(peer.address))) throw new Error('Invalid proxy gateway address');
  const sockets = new Set(), requests = new Set();
  const counts = { page: 0, api: 0, failures: 0, bytes: 0 };
  let closed = false;
  const server = createServer((_request, response) => { response.writeHead(405); response.end(); });
  server.maxConnections = 64; server.headersTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', async (incoming, client, head) => {
    // Without a lookup running there is no tunnel: nothing reaches the gateway between replies.
    const lease = currentLease ? currentLease() : null;
    if (currentLease && !lease?.open) { onUnleased(); client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); client.destroy(); return; }
    let upstream, request, timer, failed = false, untrack = () => {};
    const fail = () => {
      if (!failed) { counts.failures++; if (lease) lease.failures++; }
      failed = true; clearTimeout(timer); untrack(); client.destroy(); upstream?.destroy(); request?.destroy();
    };
    if (lease) untrack = lease.track(fail);
    // Counted before it is relayed, so a lease never relays past its allowance.
    const take = chunk => {
      counts.bytes += chunk.length; onBytes(chunk.length);
      if (lease ? !lease.take(chunk.length) : counts.bytes > MAX_LEASE_BYTES) { fail(); return false; }
      return true;
    };
    const relay = (from, to) => {
      from.on('data', chunk => {
        if (!take(chunk) || failed) return;
        if (!to.write(chunk)) { from.pause(); to.once('drain', () => from.resume()); }
      });
      from.once('end', () => { if (!failed) to.end(); });
    };
    client.once('error', fail);
    client.once('close', () => { clearTimeout(timer); untrack(); upstream?.destroy(); request?.destroy(); });
    try {
      timer = setTimeout(fail, 5000);
      const destination = fedexDestination(incoming.url);
      const addresses = await resolve(destination.host, { all: true });
      if (!addresses.length || addresses.some(peer => !publicAddress(peer.address))) throw new Error('Invalid destination');
      if (closed || failed || client.destroyed || (lease && !lease.open)) { fail(); return; }
      const peer = peers[0];
      request = (gateway.protocol === 'https:' ? requestHttps : requestHttp)({
        hostname: peer.address, family: peer.family, port: Number(gateway.port || (gateway.protocol === 'https:' ? 443 : 80)),
        servername: gateway.hostname, method: 'CONNECT', path: `${destination.host}:443`, agent: false,
        headers: { Host: `${destination.host}:443`, 'Proxy-Authorization': authorization },
      });
      requests.add(request); request.once('close', () => requests.delete(request));
      request.once('error', fail);
      request.once('connect', (response, socket, buffered) => {
        upstream = socket;
        if (response.statusCode !== 200) onRefusal({ target: destination.target, status: response.statusCode, reason: refusalReason(response.headers) });
        if (response.statusCode !== 200 || closed || failed || client.destroyed || (lease && !lease.open)) { fail(); return; }
        clearTimeout(timer);
        sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.once('error', fail);
        if (destination.target === 'page' || destination.target === 'api') { counts[destination.target]++; if (lease) lease[destination.target]++; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) { if (!take(head)) return; socket.write(head); }
        if (buffered.length) { if (!take(buffered)) return; client.write(buffered); }
        relay(socket, client); relay(client, socket);
      });
      request.end();
    } catch { fail(); }
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  return { url: `http://127.0.0.1:${server.address().port}`,
    proof: () => ({ route, family: 'unknown', pageConnections: counts.page,
      apiConnections: counts.api, connectionFailures: counts.failures, bytes: counts.bytes }),
    async close() { closed = true; for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy();
      await new Promise(done => server.close(done)); },
  };
}
