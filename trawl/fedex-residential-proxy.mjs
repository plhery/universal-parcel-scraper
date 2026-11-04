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

/** Every TLS connection goes through the configured authenticated gateway; no direct fallback. */
export async function createFedExResidentialProxy(value, { resolve = lookup, requestHttp = httpRequest,
  requestHttps = httpsRequest, onBytes = () => {}, onRefusal = () => {} } = {}) {
  let gateway;
  try { gateway = new URL(value); } catch { throw new Error('Invalid residential gateway'); }
  if (!['http:', 'https:'].includes(gateway.protocol) || !gateway.hostname || gateway.search || gateway.hash
    || !['', '/'].includes(gateway.pathname)) throw new Error('Invalid residential gateway');
  let authorization;
  try { authorization = 'Basic ' + Buffer.from(decodeURIComponent(gateway.username) + ':' + decodeURIComponent(gateway.password)).toString('base64'); }
  catch { throw new Error('Invalid residential gateway credentials'); }
  const peers = await resolve(gateway.hostname, { all: true });
  if (!peers.length || peers.some(peer => !publicAddress(peer.address))) throw new Error('Invalid residential gateway address');
  const sockets = new Set(), requests = new Set();
  const counts = { page: 0, api: 0, failures: 0, bytes: 0 };
  let closed = false;
  const server = createServer((_request, response) => { response.writeHead(405); response.end(); });
  server.maxConnections = 64; server.headersTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', async (incoming, client, head) => {
    let upstream, request, timer, failed = false;
    const fail = () => { if (!failed) counts.failures++; failed = true; clearTimeout(timer); client.destroy(); upstream?.destroy(); request?.destroy(); };
    client.once('error', fail);
    client.once('close', () => { clearTimeout(timer); upstream?.destroy(); request?.destroy(); });
    try {
      timer = setTimeout(fail, 5000);
      const destination = fedexDestination(incoming.url);
      const addresses = await resolve(destination.host, { all: true });
      if (!addresses.length || addresses.some(peer => !publicAddress(peer.address))) throw new Error('Invalid destination');
      if (closed || client.destroyed) { clearTimeout(timer); return; }
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
        if (response.statusCode !== 200 || closed || client.destroyed) { fail(); return; }
        clearTimeout(timer);
        sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.once('error', fail);
        if (destination.target === 'page' || destination.target === 'api') counts[destination.target]++;
        const bytes = chunk => { counts.bytes += chunk.length; onBytes(chunk.length);
          if (counts.bytes > 64 * 1024 * 1024) fail(); };
        client.on('data', bytes); socket.on('data', bytes);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) { bytes(head); socket.write(head); }
        if (buffered.length) { bytes(buffered); client.write(buffered); }
        socket.pipe(client); client.pipe(socket);
      });
      request.end();
    } catch { fail(); }
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  return { url: `http://127.0.0.1:${server.address().port}`,
    proof: () => ({ route: 'residential', family: 'unknown', pageConnections: counts.page,
      apiConnections: counts.api, connectionFailures: counts.failures, bytes: counts.bytes }),
    async close() { closed = true; for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy();
      await new Promise(done => server.close(done)); },
  };
}
