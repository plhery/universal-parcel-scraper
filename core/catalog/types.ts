/**
 * Catalog vocabulary.
 *
 * What it is: the shape of a merged `carrier.json` entry and the typed views
 * the application consumes (carrier info, capabilities, input requirements,
 * tracking links).
 * What it is not: no data, no behaviour and no provider I/O; every declaration
 * here is erased at build time.
 */
import type { CarrierId } from '../../generated/catalog.js';
import type { DetectionConfidence } from '../detection/types.js';

export type CarrierTrackingMode = 'automatic' | 'link-only';
export type CarrierInputField = 'trackingUrl' | 'postcode' | 'phoneDigits';
export type CarrierInputValidator =
  | 'planzerSharedUrl'
  | 'dachserCapabilityUrl'
  | 'instaboxCapabilityUrl'
  | 'truskCapabilityUrl'
  | 'freightwaysCapabilityUrl'
  | 'amazonShareUrl'
  | 'mendrixCapabilityUrl'
  | 'swissPostcode'
  | 'francePostcode'
  | 'germanyPostcode'
  | 'swissOrFrancePostcode'
  | 'internationalPostcode'
  | 'paackPostcode'
  | 'colisPrivePostcode'
  | 'phoneLastFour';

/** What the "add a parcel" forms render for a carrier that needs extra input. */
export interface CarrierInputRequirement {
  field: CarrierInputField;
  whenTrackingNumber?: string;
  /** The form may be submitted without it; a supplied value is still checked. */
  optional?: boolean;
  /**
   * An optional input the carrier shows more of the parcel with, whatever else answers: a
   * parcel saved without it is worth asking for it. Unset where the carrier needs it for only
   * some parcels of the shape and asks for those.
   */
  showsMore?: boolean;
  /**
   * The lookup reads the country the postcode is from (`postcodeCountry`), so it is worth naming
   * beside the postcode. Unset where the carrier reads the postcode alone.
   */
  readsCountry?: boolean;
  label: string;
  type: 'text' | 'url';
  placeholder?: string;
  help?: string;
  pattern?: string;
  maxLength?: number;
  inputMode?: 'numeric' | 'text' | 'url';
  autoComplete?: string;
}

/** What the server checks that extra input against. */
export interface CarrierRequirementRule {
  field: CarrierInputField;
  validator: CarrierInputValidator;
  whenTrackingNumber?: string;
  optional?: boolean;
  /** An optional input the carrier shows more of the parcel with (`CarrierInputRequirement.showsMore`). */
  showsMore?: boolean;
}

export interface CarrierCatalogRequirement
  extends CarrierInputRequirement, CarrierRequirementRule {}

export interface CarrierCapabilities {
  tracking: {
    mode: CarrierTrackingMode;
    adapter: string | null;
    requirements: CarrierInputRequirement[];
  };
  selectable: boolean;
  timezone: string;
}

export interface CarrierInfo {
  id: CarrierId;
  name: string;
  /** Other names the carrier is known by, searched by the carrier pickers. */
  aliases: readonly string[];
  /** ISO codes of the countries it delivers in under its own name, home first. */
  countries: readonly string[];
  trackingSiteName?: string;
  /** Accent used for the carrier chip in the UI. */
  color: string;
  trackingUrl?: (trackingNumber: string) => string;
  /** The carrier's public page for typing a tracking number in, linked when the number is hidden. */
  trackingSearchUrl?: string;
  /** The carrier's official help and contact page for someone receiving a parcel, linked when it stops moving. */
  helpUrl?: string;
  /** Whether the carrier's tracking leaves out the number's journey in the destination country. */
  hidesDestinationLeg?: (trackingNumber: string) => boolean;
  capabilities: CarrierCapabilities;
}

export interface DetectionRule {
  pattern: string;
  /** Additional condition on the input before separators are removed. */
  rawPattern?: string;
  confidence: Exclude<DetectionConfidence, 'none'>;
  checksum?:
    | 's10' | 'mondial-relay' | 'hermes' | 'gls' | 'dhl-express' | 'tnt' | 'poczta-polska' | 'correos-spain' | 'dpd' | 'usps' | 'sscc'
    | 'ups' | 'colissimo' | 'ukrposhta' | 'evri' | 'mod7' | 'gs1' | 'ontrac' | 'luhn' | 'fedex' | 'sf-express'
    | 'fedex-ground-96' | 'fedex-1d' | 'identcode' | 'fedex-ground-economy' | 'pos-laju' | 'saia' | 'magyar-posta' | 'poste-italiane'
    | 'frankier-id' | 'dhl-ecommerce-pl' | 'mondial-relay-head' | 'gs1-digits' | 'luhn-digits' | 's10-serial' | 'gofo-europe'
    | 'j-and-t-de' | 'cainiao-hd' | 'australia-post' | 'poczta-polska-px';
  /** Low confidence only: number evidence that lists this carrier first among suggestions. */
  preferred?: boolean;
  /** Low confidence only: a shape prose shares, offered for a number given on its own, never one read out of a text. */
  standalone?: boolean;
  /**
   * Low confidence only: a shape printed elsewhere too, such as a shop's own number. When the country hint names a
   * country the carrier does not serve, recognition asks it about a number only such rules offer only once the other
   * candidates have all missed it (`outsideCountry`).
   */
  servedCountriesOnly?: boolean;
  /**
   * Low confidence only: a shape too weak to ask the carrier about beside the others, such as a range another
   * carrier's numbers fill. Recognition asks the carrier about a number only such rules offer only once every other
   * candidate has missed it (`lastResort`).
   */
  lastResort?: boolean;
}

/** A link rule as it is written in the catalog, before its regexes compile. */
export interface RawTrackingLinkRule {
  domains: readonly string[];
  params?: readonly string[];
  /** Capture a number from the whole query, for portals without named parameters. */
  query?: string;
  /** Capture a number from the path; a path it does not capture from yields none. */
  path?: string;
  /** Limit the rule to the paths it matches, for pasted and partner links alike. */
  pathPattern?: string;
  fragment?: string;
  detectFromNumber?: boolean;
  /**
   * Name the carrier only for a number its own detection rules offer. Any other
   * number the link holds is detected on its own.
   */
  ownNumbersOnly?: boolean;
  keepsCapabilityUrl?: boolean;
}

/** One merged catalog entry: everything the app knows about a carrier. */
export interface CarrierDefinition {
  displayName: string;
  displayNames?: Record<string, string>;
  aliases?: readonly string[];
  countries?: readonly string[];
  trackingSiteName?: string;
  color: string;
  selectable: boolean;
  timezone: string;
  canaryUrl?: string;
  tracking: {
    mode: CarrierTrackingMode;
    adapter: string | null;
    upstreamName?: string;
    requirements?: readonly CarrierCatalogRequirement[];
    /** Present when the adapter can recognize a number; higher is asked first. */
    recognitionRank?: number;
    /** The normalized numbers recognition can answer; others the carrier's rules offer are not asked. */
    recognitionPattern?: string;
    /**
     * Recognition asks the carrier about a bare run of digits with the others only when the caller's country hint is
     * one of its countries; otherwise, or without a hint, only once they have all missed it (`outsideCountry`).
     */
    recognitionServedCountriesOnly?: boolean;
    /** Opt-in browser confirmation; higher is asked first after HTTP is inconclusive. */
    browserRecognitionRank?: number;
    /** The normalized numbers browser recognition asks about; others the carrier's rules offer are not asked. */
    browserRecognitionPattern?: string;
    /** The least minutes between two lookups of one number, after a failed one, and while the parcel is out for delivery. */
    refresh?: { minMinutes: number; afterFailureMinutes?: number; outForDeliveryMinutes?: number };
    localClocks?: boolean;
    /** The carrier's page states every scan on one clock of its own, not the clock where the scan happened. */
    pageClock?: boolean;
    /** Every scan the adapter dates by its day alone is one the carrier gives no clock by design. */
    dateOnlyScans?: boolean;
    /** The number is the token of the link that opens the parcel, not one the carrier prints. */
    linkToken?: boolean;
    /** A lookup can open a browser: the private browser service or a local or remote Chromium. */
    browser?: boolean;
  };
  trackingUrlTemplate?: string;
  trackingSearchUrl?: string;
  helpUrl?: string;
  /** Regular expression matched against the normalized number. */
  hidesDestinationLeg?: string;
  linkRules: readonly RawTrackingLinkRule[];
  detectionRules: readonly DetectionRule[];
}
