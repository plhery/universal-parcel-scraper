/**
 * parcelLab's shop tracking pages: `<shop>.delivery-status.com`, as H&M's "Follow package" opens, and the older
 * `prtl.parcellab.com/trackings/details`. Their script (`cdn.parcellab.com/js/v3/parcelLab.min.js`) reads the
 * shipment from the link's query: a tracking number and parcelLab's courier code (`trackingNo`/`tno`,
 * `courier`/`c`), or an order (`orderNo`, or `xid`) with the shop's parcelLab user id (`plUserId`/`u`/`userId`,
 * else the page's own `userId` option, else the `plUserId` option of a script the page loads from its own host, as
 * H&M's `./index.js`) and the link's secure hash (`s`/`secureHash`). It then asks
 * `api.parcellab.com/v2/checkpoints`, anonymously; that reply names each parcel's number and courier.
 */
import { CARRIER_CATALOG, type CarrierId } from '../../generated/catalog.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { parseTrackingInput } from '../detection/parse.js';
import { validTrackingNumber } from '../detection/valid.js';
import { linkParcel } from './parcel.js';
import type { ShopLinkFailure, ShopLinkParcel, ShopLinkResolution, ShopLinkResolveOptions, ShopTrackingLink } from './types.js';

export const PARCELLAB_API = 'https://api.parcellab.com/v2/checkpoints/';
/** A page or reply is a few kilobytes; an order's checkpoints a few dozen. */
const MOST_BYTES = 512 * 1024;
/** The page's own scripts read for the shop's account: H&M's pages load two. */
const MOST_SCRIPTS = 2;

/** parcelLab's courier codes whose name differs from the catalog's id; a code that is a catalog id names it. */
const COURIERS: Record<string, CarrierId> = {
  'dhl-germany': 'dhl', 'dhl-de': 'dhl', 'gls-germany': 'gls-de', 'gls-france': 'gls-fr', 'gls-italy': 'gls-it',
  'gls-poland': 'gls-pl', 'gls-netherlands': 'gls-nl', 'dpd-germany': 'dpd-de', 'dpd-poland': 'dpd-pl',
  'dpd-france': 'dpd-fr', 'hermes-uk': 'evri-uk', 'colissimo': 'la-poste', 'correos': 'correos-spain',
  'bring': 'bring-posten', 'post-at': 'austrian-post', 'austria-post': 'austrian-post', 'post-ch': 'swiss-post',
  'inpost-pl': 'inpost', 'royalmail': 'royal-mail',
};

const param = (url: URL, names: string[]): string | undefined => {
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
};

/** A parcelLab tracking page's link, read without fetching it. */
export function parcelLabLink(url: URL): ShopTrackingLink | undefined {
  const host = url.hostname.toLowerCase();
  const shopPage = host === 'delivery-status.com' || host.endsWith('.delivery-status.com');
  const portal = host === 'prtl.parcellab.com' && /^\/trackings\//i.test(url.pathname);
  if (!shopPage && !portal) return undefined;
  const shop = shopPage && host !== 'delivery-status.com' ? host.slice(0, -'.delivery-status.com'.length).replace(/^www\./, '') || undefined : undefined;
  return { platform: 'parcellab', url: url.href, ...(shop ? { shop } : {}) };
}

/** The catalog carrier a parcelLab courier code names, if any. */
export function parcelLabCarrier(code: string | undefined): CarrierId | undefined {
  const key = code?.trim().toLowerCase();
  if (!key) return undefined;
  if (COURIERS[key]) return COURIERS[key];
  return key in CARRIER_CATALOG && key !== 'unknown' ? key as CarrierId : undefined;
}

/**
 * The parcel a number and parcelLab's account of it make. The courier's own tracking link, when the catalog reads
 * the same number from it, names the carrier; then the courier code the shop gave parcelLab, unless the number's shape is
 * surely another carrier's; else the number's shape.
 */
export function parcelLabParcel(number: string, courier?: string, courierUrl?: string): ShopLinkParcel | undefined {
  const trackingNumber = number.trim();
  if (!validTrackingNumber(trackingNumber)) return undefined;
  const normalized = normalizeTrackingNumber(trackingNumber);
  const fromLink = courierUrl ? parseTrackingInput(courierUrl) : undefined;
  if (fromLink?.source === 'link' && fromLink.confidence === 'high' && fromLink.carrier !== 'unknown'
    && normalizeTrackingNumber(fromLink.trackingNumber) === normalized) {
    return { trackingNumber, carrier: fromLink.carrier, confidence: 'high', ...(courier ? { courierCode: courier } : {}) };
  }
  return linkParcel(trackingNumber, parcelLabCarrier(courier), courier);
}

/** The number and courier code a link carries in its query, which need no request. */
export function parcelLabLinkParcel(url: URL): ShopLinkParcel | undefined {
  const number = param(url, ['trackingNo', 'tno']);
  return number ? parcelLabParcel(number, param(url, ['courier', 'c'])) : undefined;
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MOST_BYTES) throw new Error('too large');
  const text = await response.text();
  if (text.length > MOST_BYTES) throw new Error('too large');
  return text;
}

interface CheckpointsHeader {
  tracking_number?: unknown;
  courier?: unknown;
  delivery_info?: unknown;
}

/** The parcels of `api.parcellab.com/v2/checkpoints`'s reply, returns left out. */
export function parcelLabReplyParcels(reply: unknown): ShopLinkParcel[] | undefined {
  const header = (reply as { header?: unknown } | null)?.header;
  if (!Array.isArray(header)) return undefined;
  const parcels: ShopLinkParcel[] = [];
  const seen = new Set<string>();
  for (const entry of header as CheckpointsHeader[]) {
    const info = entry?.delivery_info as { isReturn?: unknown } | undefined;
    if (info?.isReturn === true || typeof entry?.tracking_number !== 'string') continue;
    const courier = entry.courier as { name?: unknown; trackingurl?: unknown } | undefined;
    const parcel = parcelLabParcel(entry.tracking_number, typeof courier?.name === 'string' ? courier.name : undefined,
      typeof courier?.trackingurl === 'string' ? courier.trackingurl : undefined);
    const key = parcel && normalizeTrackingNumber(parcel.trackingNumber);
    if (parcel && key && !seen.has(key)) {
      seen.add(key);
      parcels.push(parcel);
    }
  }
  return parcels;
}

/** The shop's parcelLab user id its tracking page sets, `userId: 1234567`. */
export function parcelLabPageUserId(html: string): string | undefined {
  return /\buserId\s*:\s*['"]?(\d{3,12})\b/.exec(html)?.[1];
}

/**
 * The scripts a page loads from its own host, nearest parcelLab's plugin first, as the shop's options sit beside it:
 * a relative `src` such as `./index.js`, or one on the page's host. parcelLab's own and other hosts' scripts are left out.
 */
export function parcelLabPageScripts(html: string, page: URL): URL[] {
  const plugin = html.search(/parcellab-track-and-trace|cdn\.parcellab\.com/i);
  const scripts: { url: URL; at: number }[] = [];
  for (const match of html.matchAll(/<script\b[^>]*?(?<![\w-])src\s*=\s*(["']?)([^"'\s>]+)\1[^>]*>/gi)) {
    let url: URL;
    try {
      url = new URL(match[2]!.replace(/&amp;/gi, '&'), page);
    } catch {
      continue;
    }
    if (url.origin === page.origin && !scripts.some((script) => script.url.href === url.href)) scripts.push({ url, at: match.index });
  }
  if (plugin >= 0) scripts.sort((a, b) => Math.abs(a.at - plugin) - Math.abs(b.at - plugin));
  return scripts.map((script) => script.url);
}

/**
 * The accounts a page's script sets as an option's value, `plUserId: "1234567"` or `userId: 1234567`, each once. Numbers
 * that are no such key's value, as the shop's other accounts in a table by country, are not read.
 */
export function parcelLabScriptUserIds(script: string): string[] {
  const option = /(?<![\w$.])(['"]?)(?:plUserId|userId)\1\s*:\s*(['"]?)(\d{3,12})\2(?![\w.])/g;
  return [...new Set(Array.from(script.matchAll(option), (match) => match[3]!))];
}

/**
 * The shop's account from the page's own scripts, when its HTML names none: the first script that sets one, of at most
 * two. A script that sets several names none, rather than one guessed.
 */
async function scriptsUserId(scripts: URL[], load: (script: URL) => Promise<Response>): Promise<{ user: string } | { reason: ShopLinkFailure }> {
  let failed = false;
  for (const script of scripts.slice(0, MOST_SCRIPTS)) {
    const response = await load(script);
    if (!response.ok) {
      failed = true;
      continue;
    }
    const users = parcelLabScriptUserIds(await boundedText(response));
    if (users.length > 1) return { reason: 'unsupported' };
    if (users.length === 1) return { user: users[0]! };
  }
  return { reason: failed ? 'unavailable' : 'unsupported' };
}

export async function resolveParcelLabLink(link: ShopTrackingLink, options: ShopLinkResolveOptions = {}): Promise<ShopLinkResolution> {
  const base = { platform: link.platform, ...(link.shop ? { shop: link.shop } : {}) } as const;
  const url = new URL(link.url);
  const direct = parcelLabLinkParcel(url);
  if (direct) return { ...base, status: 'resolved', parcels: [direct] };
  const orderNo = param(url, ['orderNo']);
  const xid = param(url, ['xid']);
  if (!orderNo && !xid) return { ...base, status: 'unresolved', reason: 'unsupported' };
  const fetcher = options.fetcher ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const signal = () => AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(options.signal ? [options.signal] : [])]);
  const headers = { Accept: 'application/json, text/html;q=0.9', ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}) };
  try {
    let user = param(url, ['plUserId', 'u', 'userId']);
    if (!user) {
      // The page names the shop's account in its script, or in a script of its own it loads; the link leaves it out.
      const address = `${url.origin}${url.pathname}`;
      const page = await fetcher(address, { headers, signal: signal(), redirect: 'follow' });
      if (!page.ok) return { ...base, status: 'unresolved', reason: page.status === 404 || page.status === 410 ? 'not_found' : 'unavailable' };
      const html = await boundedText(page);
      user = parcelLabPageUserId(html);
      if (!user) {
        // A relative script is read against where the page landed: `/ch/fr` redirects to `/ch/fr/`.
        const landed = new URL(page.url || address);
        const found = await scriptsUserId(landed.origin === url.origin ? parcelLabPageScripts(html, landed) : [], (script) =>
          fetcher(script.href, { headers: { ...headers, Accept: '*/*' }, signal: signal(), redirect: 'manual' }));
        if ('reason' in found) return { ...base, status: 'unresolved', reason: found.reason };
        user = found.user;
      }
    }
    const query = new URLSearchParams({ ...(orderNo ? { orderNo } : { xid: xid! }), user, lang: 'en' });
    const zip = param(url, ['zip']);
    if (zip) query.set('zip', zip);
    const hash = param(url, ['s', 'secureHash']);
    if (hash) query.set('s', hash);
    const response = await fetcher(`${PARCELLAB_API}?${query}`, { headers: { ...headers, Accept: 'application/json' }, signal: signal() });
    // An order parcelLab doesn't hold, or no longer shows, is "Nothing found." with 404.
    if (response.status === 404 || response.status === 410) return { ...base, status: 'unresolved', reason: 'not_found' };
    if (response.status === 401 || response.status === 403) return { ...base, status: 'unresolved', reason: 'refused' };
    if (response.status === 429) return { ...base, status: 'unresolved', reason: 'rate_limited' };
    if (!response.ok) return { ...base, status: 'unresolved', reason: 'unavailable' };
    let reply: unknown;
    try {
      reply = JSON.parse(await boundedText(response));
    } catch {
      return { ...base, status: 'unresolved', reason: 'unavailable' };
    }
    const parcels = parcelLabReplyParcels(reply);
    if (!parcels) return { ...base, status: 'unresolved', reason: 'unavailable' };
    // An order the shop has not handed to a carrier yet lists no number.
    return parcels.length ? { ...base, status: 'resolved', parcels } : { ...base, status: 'unresolved', reason: 'no_tracking_yet' };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { ...base, status: 'unresolved', reason: 'unavailable' };
  }
}
