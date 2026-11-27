/**
 * Shop tracking-page links.
 *
 * What it is: recognizes the links shops put in shipping emails to their own tracking page, run by a platform
 * such as parcelLab, Narvar, AfterShip, Sendcloud or ParcelPanel, and a mailing tool's click redirect worded like
 * tracking, and resolves one to the carrier and tracking number of each parcel it names.
 * What it is not: no tracking. Recognition reads only the string. A link that carries its numbers resolves with no
 * request; parcelLab's order links take up to four bounded, anonymous, read-only requests to the platform (the shop's
 * page, two of the page's own scripts at most, then the order), and a click redirect a few to the mailing tool, through
 * the caller's fetch. No address or name is kept.
 * Browser-safe: plain fetch, no Node APIs. A browser's fetch hides where a redirect leads, so click redirects stay
 * unresolved there.
 */
import { carrierLinkParcel } from './parcel.js';
import { parcelLabLink, resolveParcelLabLink } from './parcellab.js';
import { platformLink, resolvePlatformLink } from './platforms.js';
import { followRedirectLink, redirectLink } from './redirects.js';
import type { ShopLinkResolution, ShopLinkResolveOptions, ShopTrackingLink } from './types.js';

export type {
  ShopLinkFailure, ShopLinkParcel, ShopLinkResolution, ShopLinkResolveOptions, ShopTrackingLink, ShopTrackingPlatform,
} from './types.js';

/** The most links one text is read for: an email prints a few dozen. */
const MOST_LINKS = 200;

/**
 * The shop tracking-page link a URL is, if it is one. With the link's `words`, its text or the words written just
 * before it, a mailing tool's click redirect is one too when they read like tracking ("Track your parcel",
 * "Sendung verfolgen") and nothing reads like unsubscribing.
 */
export function shopTrackingLink(raw: string, words?: string): ShopTrackingLink | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/[>'")\],;.!?]+$/, ''));
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return parcelLabLink(url) ?? platformLink(url) ?? (words === undefined ? undefined : redirectLink(url, words));
}

/**
 * The shop tracking-page links a text holds, each once, in the order written: links in prose and in an HTML
 * email's `href`s alike, with HTML's `&amp;` read as `&`.
 */
export function shopTrackingLinks(text: string): ShopTrackingLink[] {
  const found = new Map<string, ShopTrackingLink>();
  for (const raw of (text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).slice(0, MOST_LINKS)) {
    const link = shopTrackingLink(raw.replace(/&amp;/gi, '&'));
    if (link && !found.has(link.url)) found.set(link.url, link);
  }
  return [...found.values()];
}

/**
 * The parcels a shop tracking-page link names, or why it named none. A click redirect is followed to its destination,
 * which is never loaded: a carrier's link names its parcel, a shop platform's link is resolved as one, and any other
 * page stays unsupported.
 */
export async function resolveShopTrackingLink(link: ShopTrackingLink | string, options: ShopLinkResolveOptions = {}): Promise<ShopLinkResolution> {
  const known = typeof link === 'string' ? shopTrackingLink(link) : link;
  if (!known) return { status: 'unresolved', reason: 'unsupported' };
  if (known.platform === 'parcellab') return resolveParcelLabLink(known, options);
  if (known.platform !== 'redirect') return resolvePlatformLink(known);
  const started = Date.now();
  const followed = await followRedirectLink(known, options);
  if ('reason' in followed) return { platform: 'redirect', status: 'unresolved', reason: followed.reason };
  const parcel = carrierLinkParcel(followed.destination);
  if (parcel) return { platform: 'redirect', status: 'resolved', parcels: [parcel] };
  const shop = shopTrackingLink(followed.destination.href);
  if (!shop) return { platform: 'redirect', status: 'unresolved', reason: 'unsupported' };
  const timeoutMs = Math.max(1, (options.timeoutMs ?? 10_000) - (Date.now() - started));
  return resolveShopTrackingLink(shop, { ...options, timeoutMs });
}
