// A container that prepares sessions before it opens its port holds it only while another container under the same
// network alias serves: alone, after a reboot or a crash, it opens at once.
import { lookup as dnsLookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';

const PEER_TIMEOUT_MS = 2_000;

/** Whether another container under the network name `host` answers its health check on `port`. */
export async function warmupPeerServing(host, port, { lookup = dnsLookup, interfaces = networkInterfaces,
  fetcher = fetch, timeoutMs = PEER_TIMEOUT_MS } = {}) {
  let addresses;
  try { addresses = await lookup(host, { all: true }); } catch { return false; }
  const own = new Set(Object.values(interfaces()).flat().map(entry => entry?.address));
  for (const { address, family } of addresses) {
    if (own.has(address)) continue;
    const origin = family === 6 ? `http://[${address}]:${port}` : `http://${address}:${port}`;
    try {
      const response = await fetcher(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      if (response.ok) return true;
    } catch { /* That address does not serve. */ }
  }
  return false;
}
