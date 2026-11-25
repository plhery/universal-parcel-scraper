/* global Bun */
// Run with Bun inside the same pinned image as the primary TRAWL service.
import { BrowserPool } from '../../../browser/src/pool.ts';
import { fedexSessionNumber, fedexSessions } from './fedex-session.mjs';
import { warmFedExSession } from './fedex-warmup.mjs';
import { GatewayRotation, LeaseKeeper, WaitHistogram, containerMemory, createFedExResidentialProxy, retryGateways, retryPoolSize,
  retryRoute } from './fedex-residential-proxy.mjs';

// One route per worker. Each browser context takes the gateway fewest live contexts use and keeps it for its life.
const route = retryRoute(process.env.FEDEX_RETRY_ROUTE);
const gateways = retryGateways(process.env.FEDEX_RETRY_PROXY_URL);
// The browsers kept warm, each serving one lookup at a time.
const poolSize = retryPoolSize(process.env.FEDEX_RETRY_POOL_SIZE);
const rotation = new GatewayRotation(gateways);
let proxyBytes = 0;
// Tunnels open only under the lease of the lookup running on their browser, so every byte belongs to one lookup and
// none flows between replies. A lease id is used once: a repeated request cannot carry a second allowance.
const leases = new LeaseKeeper({ capacity: poolSize });
let unleasedTunnels = 0;
let active = 0;
// Requests taken, and those answered 503 because every browser was busy.
const requests = { accepted: 0, busy: 0 };
const browserWait = new WaitHistogram();

// A gateway refusing tunnels, as when a pinned exit goes offline, otherwise shows only as a failed lookup.
function reportRefusals(refused) {
  if (!refused?.tunnels) return;
  console.warn(JSON.stringify({ level: 'warn', event: 'fedex.gateway-refusal', tunnels: refused.tunnels,
    pageTunnels: refused.page, apiTunnels: refused.api, status: refused.status, reason: refused.reason }));
}

// A lookup's budget and its lease's grace: the lookups running at SIGTERM finish within it.
const DRAIN_MS = 45_000;
// With a drain, TRAWL's pool leaves SIGTERM to this server; without one, Playwright closed the browsers at once.
const pool = new BrowserPool({ poolSize, recycleAfterTemporaryContexts: 0, contentProcesses: 2,
  label: `fedex-${route}`, blockAds: true, memoryUsage: () => containerMemory(), drainTimeoutMs: DRAIN_MS });
// The image's pool is patched to send a lookup to a browser whose FedEx session is verified, else to the one least
// recently used, so each warm browser keeps its session (fedexBrowserPool); it consults this shared instance.
const sessions = fedexSessions;
const proxies = new Set();
const bindings = new WeakMap();
let stopping = false;
// Whether the last lookup left its browser with a verified FedEx session.
let sessionVerified = false;
let server;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // The port closes, so a caller connects to the worker replacing this one, and idle connections close at once.
  // Lookups already running finish before their tunnels and browsers close: cut, they failed the caller's read.
  if (server) {
    let timer;
    await Promise.race([server.stop(), new Promise(resolve => { timer = setTimeout(resolve, DRAIN_MS); })]);
    clearTimeout(timer);
  }
  leases.closeAll(); server?.stop(true);
  // Lookups still running end with their tunnels; the browsers close a few seconds later at most.
  await pool.shutdown(5_000);
  await Promise.allSettled([...proxies].map(proxy => proxy.close()));
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
await pool.init();

// Each browser's binding holds the lookup running on it: its lease, its gateway refusals and the bytes its proxies carried.
async function bind(browser) {
  if (bindings.has(browser)) return bindings.get(browser);
  const original = browser.newContext.bind(browser);
  const binding = { lease: null, refused: null, bytes: 0 };
  browser.newContext = async options => {
    const { gateway, release } = rotation.take();
    let proxy;
    try {
      proxy = await createFedExResidentialProxy(gateway, { route,
        onBytes: n => { proxyBytes += n; binding.bytes += n; },
        onRefusal: ({ target, status, reason }) => {
          const refused = binding.refused;
          if (!refused) return;
          refused.tunnels++; if (target === 'page' || target === 'api') refused[target]++;
          refused.status = status; refused.reason = reason;
        },
        lease: () => binding.lease, onUnleased: () => { unleasedTunnels++; } });
    } catch (error) { release(); throw error; }
    proxies.add(proxy);
    try {
      const context = await original({ ...options, proxy: { server: proxy.url } });
      context.once('close', () => { proxies.delete(proxy); release(); void proxy.close(); });
      return context;
    } catch (error) { proxies.delete(proxy); release(); await proxy.close(); throw error; }
  };
  bindings.set(browser, binding);
  return binding;
}

function metrics() {
  const labels = `route="${route}"`;
  const stats = pool.getStats();
  const memory = containerMemory();
  return [
    '# TYPE fedex_retry_proxy_bytes_total counter', `fedex_retry_proxy_bytes_total{${labels}} ${proxyBytes}`,
    '# TYPE fedex_retry_proxy_leases_total counter',
    ...Object.entries(leases.ends).map(([end, count]) => `fedex_retry_proxy_leases_total{${labels},end="${end}"} ${count}`),
    '# TYPE fedex_retry_proxy_unleased_tunnels_total counter', `fedex_retry_proxy_unleased_tunnels_total{${labels}} ${unleasedTunnels}`,
    '# TYPE fedex_retry_requests_total counter',
    ...Object.entries(requests).map(([outcome, count]) => `fedex_retry_requests_total{${labels},outcome="${outcome}"} ${count}`),
    '# TYPE fedex_retry_pool_browsers gauge', `fedex_retry_pool_browsers{${labels}} ${poolSize}`,
    '# TYPE fedex_retry_pool_live gauge', `fedex_retry_pool_live{${labels}} ${stats.live}`,
    '# TYPE fedex_retry_active_lookups gauge', `fedex_retry_active_lookups{${labels}} ${active}`,
    ...browserWait.lines('fedex_retry_browser_wait_seconds', labels),
    ...(memory ? ['# TYPE fedex_retry_memory_working_set_bytes gauge',
      `fedex_retry_memory_working_set_bytes{${labels}} ${memory.workingSetBytes ?? memory.currentBytes}`,
      ...(memory.limitBytes === null ? [] : ['# TYPE fedex_retry_memory_limit_bytes gauge', `fedex_retry_memory_limit_bytes{${labels}} ${memory.limitBytes}`])] : []),
    ''].join('\n');
}

// One lookup on a warm browser, for /scrape and the warm-up; `counted` ones are callers' (fedex_retry_requests_total).
async function lookup(body, signal, counted = true) {
  // Every browser is serving a lookup: the caller waits out Retry-After or takes another route.
  if (stopping || active >= poolSize) {
    if (!stopping && counted) requests.busy++;
    return { status: 503, busy: true };
  }
  const issued = leases.issue(body);
  if (!issued.lease) return { status: issued.status };
  active++; if (counted) requests.accepted++;
  const started = Date.now(); let handle;
  const budget = Math.min(40_000, body.maxTimeout);
  try {
    return await leases.run(issued.lease, budget, async lease => {
      handle = await pool.acquire('www.fedex.com', budget);
      browserWait.observe((Date.now() - started) / 1000);
      const binding = await bind(handle.browser);
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0 || signal.aborted) return { status: 504 };
      // A caller that goes away, as when the consumer's worker restarts, closes the lease and with it the
      // lookup's tunnels. The browser stays: the session code keeps the context only if the lookup was accepted.
      const cancel = () => { lease.close(); };
      signal.addEventListener('abort', cancel, { once: true });
      binding.lease = lease; binding.refused = { tunnels: 0, page: 0, api: 0, status: null, reason: null };
      const before = binding.bytes;
      let result;
      try {
        result = await sessions.run({ url: body.url, handle, tier: 3, maxTimeout: remaining,
          capture: { captureResponses: body.captureResponses, settleTimeout: 250 } });
      } finally {
        signal.removeEventListener('abort', cancel); reportRefusals(binding.refused); lease.close();
        binding.lease = null; binding.refused = null;
      }
      sessionVerified = sessions.verified(handle.browser);
      // Bytes on this browser's tunnels outside this lease since it began: none, as no tunnel opens without one.
      const proof = { route, family: 'unknown', pageConnections: lease.page, apiConnections: lease.api,
        connectionFailures: lease.failures, bytes: lease.bytes, idleBytes: Math.max(0, binding.bytes - before - lease.bytes),
        lease: lease.id, allowance: lease.allowance, limited: lease.limited };
      // No rendered page, cookies, proxy address or destination addresses leave this endpoint.
      return { status: 200, reply: { ...result, html: '', body: '', cookies: [], fedexEgress: proof } };
    });
  } catch { return { status: 502 }; }
  finally { if (handle) pool.release(handle.id, handle.lease); active--; }
}

async function respond(request) {
  const path = new URL(request.url).pathname;
  if (path === '/health' && request.method === 'GET') return Response.json({ status: stopping ? 'stopping' : 'ok', mode: `fedex-${route}`,
    route, gateways: gateways.length, browsers: poolSize }, { status: stopping ? 503 : 200 });
  if (path === '/metrics' && request.method === 'GET') return new Response(metrics(), { headers: { 'content-type': 'text/plain; version=0.0.4' } });
  if (path !== '/scrape' || request.method !== 'POST') return new Response(null, { status: 404 });
  let body;
  try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
  if (!fedexSessionNumber(body?.url, body) || body.skipHttp !== true || body.maxTier !== 3
    || !Number.isFinite(body.maxTimeout) || body.maxTimeout < 1) return new Response(null, { status: 400 });
  const answer = await lookup(body, request.signal);
  if (answer.reply) return Response.json(answer.reply);
  return new Response(null, { status: answer.status, ...(answer.busy ? { headers: { 'Retry-After': '1' } } : {}) });
}

const port = Number(process.env.PORT ?? 8192);
// With FEDEX_WARMUP_NUMBER set, a worker started while another under FEDEX_WARMUP_PEER serves opens its port once
// a warm-up lookup leaves a verified session, or after FEDEX_WARMUP_MS; alone, it opens at once (fedex-warmup.mjs).
const warmupNumber = process.env.FEDEX_WARMUP_NUMBER?.trim();
if (warmupNumber) {
  await warmFedExSession({ number: warmupNumber, lookup: body => lookup(body, new AbortController().signal, false),
    verified: () => sessionVerified, stopped: () => stopping, peerHost: process.env.FEDEX_WARMUP_PEER?.trim(), port }).catch(() => {});
}
if (!stopping) server = Bun.serve({ hostname: process.env.HOST ?? '127.0.0.1', port, maxRequestBodySize: 16_384, idleTimeout: 60,
  fetch: respond });
