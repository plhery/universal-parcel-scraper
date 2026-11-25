/**
 * Shop tracking-page links.
 *
 * What it is: recognizes the links shops put in shipping emails to their own tracking page, run by a platform
 * such as parcelLab, and resolves one to the carrier and tracking number of each parcel it names.
 * What it is not: no tracking. Recognition reads only the string; resolution makes a bounded, anonymous,
 * read-only request or two to the platform, through the caller's fetch, and keeps no address or name.
 * Browser-safe: plain fetch, no Node APIs.
 */
import { parcelLabLink, resolveParcelLabLink } from './parcellab.js';
import type { ShopLinkResolution, ShopLinkResolveOptions, ShopTrackingLink } from './types.js';

export type {
  ShopLinkFailure, ShopLinkParcel, ShopLinkResolution, ShopLinkResolveOptions, ShopTrackingLink, ShopTrackingPlatform,
} from './types.js';

/** The most links one text is read for: an email prints a few dozen. */
const MOST_LINKS = 200;

/** The shop tracking-page link a URL is, if it is one. */
export function shopTrackingLink(raw: string): ShopTrackingLink | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/[>'")\],;.!?]+$/, ''));
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return parcelLabLink(url);
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

/** The parcels a shop tracking-page link names, or why it named none. */
export function resolveShopTrackingLink(link: ShopTrackingLink | string, options: ShopLinkResolveOptions = {}): Promise<ShopLinkResolution> {
  const known = typeof link === 'string' ? shopTrackingLink(link) : link;
  if (!known) return Promise.resolve({ status: 'unresolved', reason: 'unsupported' });
  return resolveParcelLabLink(known, options);
}
