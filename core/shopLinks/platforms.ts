/**
 * Shop tracking pages whose link carries the parcel: Narvar, AfterShip, Sendcloud and ParcelPanel. The number, and
 * the courier where the link names it, are read from the link alone, with no request. Their links that name an order
 * instead (Narvar's `order_number`, AfterShip's `order-status`, ParcelPanel's `order` and `token`) need the buyer's
 * e-mail or postcode on the platform's page, and stay unresolved.
 */
import type { CarrierId } from '../../generated/catalog.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { linkParcel } from './parcel.js';
import type { ShopLinkParcel, ShopLinkResolution, ShopTrackingLink, ShopTrackingPlatform } from './types.js';

/** The most numbers one link lists: Narvar joins a shipment's numbers with commas. */
const MOST_NUMBERS = 10;

/**
 * Narvar's carrier path segments (`/<retailer>/tracking/<carrier>?tracking_numbers=…`, Oracle's Narvar integration
 * guide). Narvar publishes no list; only names no other carrier shares are mapped, and the rest left to the number.
 */
const NARVAR: Record<string, CarrierId> = { ups: 'ups', fedex: 'fedex', usps: 'usps' };

/** AfterShip's courier slugs (its public courier list, as its WooCommerce plugin ships it). */
const AFTERSHIP: Record<string, CarrierId> = {
  'ups': 'ups', 'fedex': 'fedex', 'usps': 'usps', 'dhl': 'dhl-express', 'dhl-germany': 'dhl', 'deutsch-post': 'dhl',
  'dhl-global-mail': 'dhl-ecommerce', 'postnl': 'spring-gds', 'postnl-international': 'spring-gds', 'bpost': 'bpost',
  'bpost-international': 'bpost', 'colissimo': 'la-poste', 'la-poste-colissimo': 'la-poste',
  'chronopost-france': 'chronopost', 'colis-prive': 'colis-prive', 'mondialrelay': 'mondial-relay',
  'mondialrelay-fr': 'mondial-relay', 'dpd-de': 'dpd-de', 'exapaq': 'dpd-fr', 'dpd-uk': 'dpd-uk',
  'interlink-express': 'dpd-uk', 'dpd-nl': 'dpd-nl', 'gls-netherlands': 'gls-nl', 'gls-italy': 'gls-it',
  'gls-spain': 'gls-es', 'hermes-de': 'hermes-de', 'myhermes-uk': 'evri-uk', 'royal-mail': 'royal-mail',
  'parcel-force': 'parcelforce', 'spain-correos-es': 'correos-spain', 'spanish-seur': 'seur', 'mrw-spain': 'mrw',
  'mrw': 'mrw', 'poste-italiane': 'poste-italiane', 'brt-it': 'brt', 'inpost-paczkomaty': 'inpost',
  'inpost-uk': 'inpost', 'austrian-post': 'austrian-post', 'austrian-post-registered': 'austrian-post',
  'swiss-post': 'swiss-post', 'canada-post': 'canada-post', 'australia-post': 'australia-post', 'ontrac': 'ontrac',
  'amazon-logistics': 'amazon-logistics',
};

/** Sendcloud's carrier codes (`carrier` in its tracking API and its `/forward` links), by where each one forwards. */
const SENDCLOUD: Record<string, CarrierId> = {
  ups: 'ups', fedex: 'fedex', dhl_express: 'dhl-express', dhl_de: 'dhl', dp: 'dhl', dhl_ecommerce: 'dhl-ecommerce',
  dhl: 'dhl-ecommerce-nl', postnl: 'spring-gds', bpost: 'bpost', colissimo: 'la-poste', chronopost: 'chronopost',
  colisprive: 'colis-prive', mondial_relay: 'mondial-relay', dpd: 'dpd-de', dpd_fr: 'dpd-fr', dpd_gb: 'dpd-uk',
  dpd_local: 'dpd-uk', dpd_at: 'dpd-at', gls_de: 'gls-de', gls_nl: 'gls-nl', gls_it: 'gls-it', gls_es: 'gls-es',
  hermes_de: 'hermes-de', hermes_gb: 'evri-uk', evri_international: 'evri', royal_mail: 'royal-mail',
  parcelforce: 'parcelforce', correos: 'correos-spain', correos_express: 'correos-express', seur: 'seur', mrw: 'mrw',
  poste_italiane: 'poste-italiane', brt: 'brt', inpost_pl: 'inpost', inpost_gb: 'inpost', inpost_it: 'inpost',
  postat: 'austrian-post', amazon: 'amazon-shipping',
};

const lower = (value: string | null | undefined) => value?.trim().toLowerCase() || undefined;
const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const param = (url: URL, ...names: string[]) => names.map((name) => url.searchParams.get(name)?.trim()).find(Boolean);
const segments = (url: URL) => url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));

interface Reading {
  /** The numbers the link carries, and the platform's courier code when it names one. */
  numbers: string[];
  courier?: string;
  carriers: Record<string, CarrierId>;
}

interface Platform {
  platform: ShopTrackingPlatform;
  /** The shop the link names, or '' for a link of this platform that names none; undefined for another link. */
  shop: (url: URL) => string | undefined;
  read: (url: URL) => Reading | undefined;
}

const NARVAR_PLATFORM: Platform = {
  platform: 'narvar',
  shop(url) {
    const host = url.hostname.toLowerCase();
    if (!under(host, 'narvar.com')) return undefined;
    // `/<retailer>/tracking/<carrier>`, or `/tracking/<retailer>/<carrier>`.
    const [first, second] = segments(url).map((segment) => segment.toLowerCase());
    const retailer = second === 'tracking' ? first : first === 'tracking' ? second : undefined;
    return retailer && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(retailer) ? retailer : '';
  },
  read(url) {
    const parts = segments(url).map((segment) => segment.toLowerCase());
    const at = parts.indexOf('tracking');
    if (at < 0) return undefined;
    const courier = at === 0 ? parts[2] : parts[at + 1];
    const numbers = (param(url, 'tracking_numbers') ?? '').split(',');
    return { numbers, courier, carriers: NARVAR };
  },
};

const AFTERSHIP_PLATFORM: Platform = {
  platform: 'aftership',
  shop(url) {
    const host = url.hostname.toLowerCase();
    if (!under(host, 'aftership.com')) return undefined;
    const org = host.slice(0, -'.aftership.com'.length);
    return host !== 'aftership.com' && !['www', 'track'].includes(org) && /^[a-z0-9-]{1,63}$/.test(org) ? org : '';
  },
  read(url) {
    // `track.aftership.com/trackings?courier=…&tracking-numbers=…`, `www.aftership.com/track?c=…&t=…`.
    const queried = param(url, 'tracking-numbers', 't');
    if (queried) return { numbers: queried.split(','), courier: lower(param(url, 'courier', 'c')), carriers: AFTERSHIP };
    // `<org>.aftership.com/<number>`, `track.aftership.com/<slug>/<number>`, `www.aftership.com/track/<slug>/<number>`.
    const parts = segments(url);
    if (parts[0]?.toLowerCase() === 'track') parts.shift();
    if (parts.length === 1) return { numbers: [parts[0]!], carriers: AFTERSHIP };
    if (parts.length === 2 && /^[a-z0-9-]{2,40}$/i.test(parts[0]!)) return { numbers: [parts[1]!], courier: lower(parts[0]), carriers: AFTERSHIP };
    return undefined;
  },
};

const SENDCLOUD_PLATFORM: Platform = {
  platform: 'sendcloud',
  shop(url) {
    const host = url.hostname.toLowerCase();
    // `tracking.sendcloud.sc/forward?carrier=…&code=…` and its regional hosts, `tracking.<region>.sendcloud.sc`.
    if (under(host, 'sendcloud.sc')) return host.startsWith('tracking.') ? '' : undefined;
    // A shop's branded page, `<brand>.shipping-portal.com/tracking/?tracking_number=…`.
    if (!host.endsWith('.shipping-portal.com')) return undefined;
    const brand = host.slice(0, -'.shipping-portal.com'.length);
    return /^[a-z0-9-]{1,63}$/.test(brand) ? brand : '';
  },
  read(url) {
    if (url.hostname.toLowerCase().endsWith('.shipping-portal.com')) {
      const number = param(url, 'tracking_number');
      return number ? { numbers: [number], carriers: SENDCLOUD } : undefined;
    }
    if (!/^\/forward\/?$/i.test(url.pathname)) return undefined;
    const number = param(url, 'code');
    return number ? { numbers: [number], courier: lower(param(url, 'carrier')), carriers: SENDCLOUD } : undefined;
  },
};

const PARCELPANEL_PLATFORM: Platform = {
  platform: 'parcelpanel',
  // A Shopify shop's own address: `<shop>/apps/parcelpanel?nums=…`.
  shop: (url) => /^\/apps\/parcelpanel\/?$/i.test(url.pathname)
    ? url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.myshopify\.com$/, '')
    : undefined,
  read(url) {
    const number = param(url, 'nums');
    return number ? { numbers: [number], carriers: {} } : undefined;
  },
};

const PLATFORMS = [NARVAR_PLATFORM, AFTERSHIP_PLATFORM, SENDCLOUD_PLATFORM, PARCELPANEL_PLATFORM];

/** A link to a Narvar, AfterShip, Sendcloud or ParcelPanel tracking page, read without fetching it. */
export function platformLink(url: URL): ShopTrackingLink | undefined {
  for (const { platform, shop } of PLATFORMS) {
    const named = shop(url);
    if (named !== undefined) return { platform, url: url.href, ...(named ? { shop: named } : {}) };
  }
  return undefined;
}

/** The parcels such a link carries, each once, or none when it names an order instead. */
export function platformLinkParcels(url: URL, platform: ShopTrackingPlatform): ShopLinkParcel[] {
  const reading = PLATFORMS.find((candidate) => candidate.platform === platform)?.read(url);
  if (!reading) return [];
  const carrier = reading.courier ? reading.carriers[reading.courier] : undefined;
  const parcels = new Map<string, ShopLinkParcel>();
  for (const number of reading.numbers.slice(0, MOST_NUMBERS)) {
    const parcel = linkParcel(number, carrier, reading.courier);
    const key = parcel && normalizeTrackingNumber(parcel.trackingNumber);
    if (parcel && key && !parcels.has(key)) parcels.set(key, parcel);
  }
  return [...parcels.values()];
}

export function resolvePlatformLink(link: ShopTrackingLink): ShopLinkResolution {
  const base = { platform: link.platform, ...(link.shop ? { shop: link.shop } : {}) } as const;
  const parcels = platformLinkParcels(new URL(link.url), link.platform);
  return parcels.length ? { ...base, status: 'resolved', parcels } : { ...base, status: 'unresolved', reason: 'unsupported' };
}
