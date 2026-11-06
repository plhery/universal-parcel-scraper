/* global Bun */
// Run with Bun inside the same pinned image as the primary TRAWL service.
import { BrowserPool } from '../../../browser/src/pool.ts';
import { FedExSessions, fedexSessionNumber } from './fedex-session.mjs';
import { LeaseKeeper, createFedExResidentialProxy, retryGateways, retryRoute } from './fedex-residential-proxy.mjs';

// One route per worker. Each browser context draws one of the gateways and keeps it for its life.
const route = retryRoute(process.env.FEDEX_RETRY_ROUTE);
const gateways = retryGateways(process.env.FEDEX_RETRY_PROXY_URL);
let proxyBytes = 0;
// Tunnels open only under the running lookup's lease, so every byte belongs to one lookup and none flows between replies.
// A lease id is used once: a repeated request cannot carry a second allowance for the same reservation.
const leases = new LeaseKeeper();
let unleasedTunnels = 0;
// The worker serves one lookup at a time, so the change in these counts over a lookup is that lookup's.
const refused = { tunnels: 0, page: 0, api: 0, status: null, reason: null };
const onRefusal = ({ target, status, reason }) => {
  refused.tunnels++; if (target === 'page' || target === 'api') refused[target]++;
  refused.status = status; refused.reason = reason;
};
// A gateway refusing tunnels, as when a pinned exit goes offline, otherwise shows only as a failed lookup.
function reportRefusals(before) {
  if (refused.tunnels === before.tunnels) return;
  console.warn(JSON.stringify({ level: 'warn', event: 'fedex.gateway-refusal', tunnels: refused.tunnels - before.tunnels,
    pageTunnels: refused.page - before.page, apiTunnels: refused.api - before.api, status: refused.status, reason: refused.reason }));
}

const pool = new BrowserPool({ poolSize: 1, recycleAfterTemporaryContexts: 0, contentProcesses: 2,
  label: `fedex-${route}`, blockAds: true });
const sessions = new FedExSessions();
const proxies = new Set();
const bindings = new WeakMap();
let active = false, stopping = false;
await pool.init();

async function bind(browser) {
  if (bindings.has(browser)) return bindings.get(browser);
  const original = browser.newContext.bind(browser);
  const binding = { current: null };
  browser.newContext = async options => {
    const gateway = gateways[Math.floor(Math.random() * gateways.length)];
    const proxy = await createFedExResidentialProxy(gateway, { route, onBytes: n => { proxyBytes += n; }, onRefusal,
      lease: () => leases.current, onUnleased: () => { unleasedTunnels++; } }); proxies.add(proxy);
    try {
      const context = await original({ ...options, proxy: { server: proxy.url } });
      binding.current = proxy;
      context.once('close', () => { proxies.delete(proxy); void proxy.close(); });
      return context;
    } catch (error) { proxies.delete(proxy); await proxy.close(); throw error; }
  };
  bindings.set(browser, binding);
  return binding;
}

const server = Bun.serve({
  hostname: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8192),
  maxRequestBodySize: 16_384, idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({ status: stopping ? 'stopping' : 'ok', mode: `fedex-${route}`,
      route, gateways: gateways.length }, { status: stopping ? 503 : 200 });
    if (path === '/metrics' && request.method === 'GET') return new Response([
      '# TYPE fedex_retry_proxy_bytes_total counter', `fedex_retry_proxy_bytes_total{route="${route}"} ${proxyBytes}`,
      '# TYPE fedex_retry_proxy_leases_total counter',
      ...Object.entries(leases.ends).map(([end, count]) => `fedex_retry_proxy_leases_total{route="${route}",end="${end}"} ${count}`),
      '# TYPE fedex_retry_proxy_unleased_tunnels_total counter', `fedex_retry_proxy_unleased_tunnels_total{route="${route}"} ${unleasedTunnels}`,
      ''].join('\n'), { headers: { 'content-type': 'text/plain; version=0.0.4' } });
    if (path !== '/scrape' || request.method !== 'POST') return new Response(null, { status: 404 });
    let body;
    try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
    if (!fedexSessionNumber(body?.url, body) || body.skipHttp !== true || body.maxTier !== 3
      || !Number.isFinite(body.maxTimeout) || body.maxTimeout < 1) return new Response(null, { status: 400 });
    if (stopping || active) return new Response(null, { status: 503, headers: { 'Retry-After': '1' } });
    const issued = leases.issue(body);
    if (!issued.lease) return new Response(null, { status: issued.status });
    active = true;
    const started = Date.now(); let handle;
    const before = proxyBytes;
    const budget = Math.min(40_000, body.maxTimeout);
    try {
      return await leases.run(issued.lease, budget, async lease => {
        handle = await pool.acquire('www.fedex.com', budget);
        await bind(handle.browser);
        const remaining = budget - (Date.now() - started);
        if (remaining <= 0 || request.signal.aborted) return new Response(null, { status: 504 });
        const cancel = () => { lease.close(); handle.requestBrowserReplacement?.('FedEx retry request cancelled'); };
        request.signal.addEventListener('abort', cancel, { once: true });
        const refusedBefore = { ...refused };
        let result;
        try {
          result = await sessions.run({ url: body.url, handle, tier: 3, maxTimeout: remaining,
            capture: { captureResponses: body.captureResponses, settleTimeout: 250 } });
        } finally { request.signal.removeEventListener('abort', cancel); reportRefusals(refusedBefore); lease.close(); }
        // Bytes outside this lease since it began: none, as no tunnel opens without one.
        const proof = { route, family: 'unknown', pageConnections: lease.page, apiConnections: lease.api,
          connectionFailures: lease.failures, bytes: lease.bytes, idleBytes: Math.max(0, proxyBytes - before - lease.bytes),
          lease: lease.id, allowance: lease.allowance, limited: lease.limited };
        // No rendered page, cookies, proxy address or destination addresses leave this endpoint.
        return Response.json({ ...result, html: '', body: '', cookies: [], fedexEgress: proof });
      });
    } catch { return new Response(null, { status: 502 }); }
    finally { if (handle) pool.release(handle.id, handle.lease); active = false; }
  },
});

async function shutdown() {
  if (stopping) return;
  stopping = true; leases.current?.close(); server.stop(true);
  await pool.shutdown();
  await Promise.allSettled([...proxies].map(proxy => proxy.close()));
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
