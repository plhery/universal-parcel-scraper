import type { CarrierId } from '../../generated/catalog.js';
import type { DetectionConfidence } from '../detection/types.js';

/** The shop tracking-page platforms whose links name a parcel. */
export type ShopTrackingPlatform = 'parcellab' | 'narvar' | 'aftership' | 'sendcloud' | 'parcelpanel';

/** A link to a shop's tracking page, which names a parcel without being a carrier's link. */
export interface ShopTrackingLink {
  platform: ShopTrackingPlatform;
  url: string;
  /** The shop the page is for, as its address names it (`hm` for `hm.delivery-status.com`, a ParcelPanel shop's domain). */
  shop?: string;
}

/** A parcel a shop's tracking page names. */
export interface ShopLinkParcel {
  trackingNumber: string;
  carrier: CarrierId;
  confidence: DetectionConfidence;
  /** The platform's own code for the courier, as the shop gave it. */
  courierCode?: string;
}

/**
 * Why a link named no parcel: the platform holds no such order or no longer shows it (`not_found`), the order has
 * no tracking number yet, as before dispatch (`no_tracking_yet`), the platform refused the request or limited its
 * rate, did not answer readably (`unavailable`), or the link is of a form no resolver reads (`unsupported`).
 */
export type ShopLinkFailure = 'not_found' | 'no_tracking_yet' | 'refused' | 'rate_limited' | 'unavailable' | 'unsupported';

export type ShopLinkResolution =
  | { platform: ShopTrackingPlatform; shop?: string; status: 'resolved'; parcels: ShopLinkParcel[] }
  /** `platform` is absent for a link no platform's resolver recognizes. */
  | { platform?: ShopTrackingPlatform; shop?: string; status: 'unresolved'; reason: ShopLinkFailure };

export interface ShopLinkResolveOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** The whole resolution's time, all requests included. Defaults to ten seconds. */
  timeoutMs?: number;
  userAgent?: string;
}
