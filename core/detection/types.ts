/**
 * Detection vocabulary.
 *
 * What it is: the result shapes the detection engine returns and its callers
 * pass around (confidence, candidate carriers, parsed input).
 * What it is not: no provider I/O, no application or framework types. These
 * declarations are erased at build time and safe to import from anywhere.
 */
import type { CarrierId } from '../../generated/catalog.js';
import type { DetectionRule } from '../catalog/types.js';

export type DetectionConfidence = 'high' | 'low' | 'none';

export interface CarrierDetection {
  carrier: CarrierId;
  confidence: DetectionConfidence;
  candidates: CarrierId[];
  /** Candidates a `preferred` rule backs with number evidence, listed first. */
  preferred: CarrierId[];
  /**
   * Carriers that follow some parcels under this number from an earlier leg,
   * beside the one high-confidence carrier that issues it, such as Cainiao
   * under GOFO's GFUS waybills. They are no candidates: asking one may add the
   * scans before the issuer's. Absent when there is none.
   */
  origins?: CarrierId[];
}

export interface TrackingInputMatch extends CarrierDetection {
  trackingNumber: string;
  trackingUrl?: string;
  source: 'number' | 'link' | 'text' | 'none';
}

/** A detection rule whose checksum failed for a number its pattern fits. */
export interface ChecksumRejection {
  carrier: CarrierId;
  /** The rule's stable id in the carrier's `carrier.json`. */
  rule: string;
  checksum: NonNullable<DetectionRule['checksum']>;
}
