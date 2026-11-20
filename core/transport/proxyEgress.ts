import { ProxyAgent, type Dispatcher } from 'undici';
import type { Egress } from './egress.js';

/**
 * Egresses through HTTP(S) proxies, one per URL, for a host's `egressPools` (Node only). The list may
 * be separated by commas, spaces or new lines. Each egress keeps its connections, and its `id`
 * (`<pool>-<n>`) names neither the address nor the credentials. Make the pool once per process: a
 * carrier's turns belong to each egress's fetcher.
 */
export function proxyEgressPool(urls: string | readonly string[] | undefined, pool = 'proxy', fetcher: typeof fetch = fetch): Egress[] {
  const listed = (typeof urls === 'string' ? urls.split(/[\s,]+/) : urls ?? []).map(url => url.trim()).filter(Boolean);
  return listed.map((raw, index) => {
    let proxy: URL;
    try { proxy = new URL(raw); } catch { throw new TypeError(`${pool} egress ${index + 1} must be an HTTP proxy URL`); }
    if (!['http:', 'https:'].includes(proxy.protocol)) throw new TypeError(`${pool} egress ${index + 1} must be an HTTP proxy URL`);
    const token = proxy.username || proxy.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : undefined;
    const dispatcher: Dispatcher = new ProxyAgent({ uri: proxy.origin, ...(token ? { token } : {}) });
    const send: typeof fetch = (input, init) => fetcher(input, { ...init, dispatcher } as RequestInit);
    return { id: `${pool}-${index + 1}`, fetcher: send };
  });
}
