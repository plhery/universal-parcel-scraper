/**
 * The carrier catalog, as a consumer reads it.
 *
 * What it is: the `CARRIERS` record derived from the generated catalog, the
 * per-carrier lookups, and the tracking links that follow from catalog data
 * alone (carrier portals, localized URLs).
 * What it is not: no provider I/O, no HTTP, no application or framework code.
 * Everything here is a pure function of the catalog and its arguments.
 */
import { normalizeCourierGuyNumber } from '../../carriers/the-courier-guy/number.js';
import { postlogisticsIdentifier } from '../../carriers/postlogistics/number.js';
import type { CarrierId } from '../../generated/catalog.js';
import { isValidMondialRelayBarcode } from '../detection/mondialRelay.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { amazonOrdersUrl, amazonShippingUrl } from './amazon.js';
import { CARRIER_DEFINITIONS } from './definitions.js';
import type { CarrierDefinition, CarrierInfo, CarrierInputRequirement } from './types.js';

export * from './types.js';
export * from './definitions.js';
export * from './linkRules.js';
export * from './amazon.js';

/** Carrier-specific printed identifiers expected by the official portal. */
export function trackingNumberForLink(carrierId: CarrierId, raw: string): string {
  const normalized = normalizeTrackingNumber(raw);
  if (carrierId === 'mondial-relay' && isValidMondialRelayBarcode(normalized)) return normalized.slice(0, 12);
  if (carrierId === 'c-chez-vous') {
    const composite = /^([A-Z0-9]{11})(\d{5})$/.exec(normalized);
    if (composite) return `${composite[1]}--${composite[2]}`;
  }
  if (carrierId === 'the-courier-guy') {
    const product = /^(DD|LD)([A-Z0-9]{6})$/.exec(normalized);
    if (product) return normalizeCourierGuyNumber(normalized);
  }
  if (carrierId === 'postlogistics') return postlogisticsIdentifier(raw);
  return raw;
}

/** Build a carrier's portal link factory from its catalog template. */
export function trackingLink(carrierId: CarrierId, template: string | undefined) {
  if (carrierId === 'amazon-logistics') return amazonOrdersUrl;
  if (carrierId === 'amazon-shipping') return amazonShippingUrl;
  if (!template) return undefined;
  return (trackingNumber: string) =>
    template.replace(
      '{trackingNumber}',
      encodeURIComponent(trackingNumberForLink(carrierId, trackingNumber)),
    );
}

function builtCarrierInfo(id: CarrierId, carrier: CarrierDefinition): CarrierInfo {
  return {
    id,
    name: carrier.displayName,
    aliases: carrier.aliases ?? [],
    countries: carrier.countries ?? [],
    trackingSiteName: carrier.trackingSiteName,
    color: carrier.color,
    trackingUrl: trackingLink(id, carrier.trackingUrlTemplate),
    capabilities: {
      tracking: {
        mode: carrier.tracking.mode,
        adapter: carrier.tracking.adapter,
        requirements: [...(carrier.tracking.requirements ?? [])],
      },
      selectable: carrier.selectable,
      timezone: carrier.timezone,
    },
  };
}

export const CARRIERS = Object.fromEntries(
  Object.entries(CARRIER_DEFINITIONS).map(([id, carrier]) => [
    id,
    builtCarrierInfo(id as CarrierId, carrier),
  ]),
) as Record<CarrierId, CarrierInfo>;

export function carrierInfo(id: CarrierId, locale?: string): CarrierInfo {
  const carrier = CARRIERS[id] ?? CARRIERS.unknown;
  const name = locale ? CARRIER_DEFINITIONS[carrier.id].displayNames?.[locale] : undefined;
  return name ? { ...carrier, name } : carrier;
}

export const SELECTABLE_CARRIERS = Object.values(CARRIERS).filter(
  (carrier) => carrier.capabilities.selectable,
);

/** The requirements a form shows for one number, matched unanchored. */
export function carrierRequirements(
  carrierId: CarrierId,
  trackingNumber: string,
): CarrierInputRequirement[] {
  const normalized = normalizeTrackingNumber(trackingNumber);
  return CARRIERS[carrierId].capabilities.tracking.requirements.filter(
    (requirement) =>
      !requirement.whenTrackingNumber
      || new RegExp(requirement.whenTrackingNumber).test(normalized),
  );
}

/**
 * Whether a form value lets the parcel be saved: blank passes only for an
 * optional input, and a value that is typed must still match the pattern.
 */
export function requirementSatisfied(
  requirement: Pick<CarrierInputRequirement, 'optional' | 'pattern'>,
  raw: string,
): boolean {
  const value = raw.trim();
  if (!value) return requirement.optional === true;
  return !requirement.pattern || new RegExp(requirement.pattern).test(value);
}

export function tracksAutomatically(carrierId: CarrierId): boolean {
  return CARRIERS[carrierId].capabilities.tracking.mode === 'automatic';
}

/** Point a carrier portal at the reader's language when the site supports it. */
export function localizedCarrierUrl(
  carrierId: CarrierId,
  url: string,
  locale?: string,
): string {
  if (!locale || !['en', 'de', 'fr', 'it', 'es', 'pt', 'pl'].includes(locale)) return url;
  try {
    const localizedUrl = new URL(url);
    if (carrierId === 'swiss-post') {
      localizedUrl.searchParams.set('lang', ['en', 'de', 'fr', 'it'].includes(locale) ? locale : 'en');
    } else if (localizedUrl.hostname === 't.17track.net' || localizedUrl.hostname === 'parcelsapp.com') {
      // Parcels supports Spanish and Portuguese, but has no Polish page.
      const siteLocale = localizedUrl.hostname === 'parcelsapp.com' && locale === 'pl' ? 'en' : locale;
      localizedUrl.pathname = localizedUrl.pathname.replace(/^\/[a-z]{2}(?=\/|$)/i, `/${siteLocale}`);
    } else {
      return url;
    }
    return localizedUrl.toString();
  } catch {
    return url;
  }
}
