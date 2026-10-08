import { sameInstantIdentityPolicy as aliexpress } from '../../carriers/aliexpress/app.js';
import { sameInstantIdentityPolicy as amazonShipping } from '../../carriers/amazon-shipping/app.js';
import { sameInstantIdentityPolicy as australiaPost } from '../../carriers/australia-post/app.js';
import { sameInstantIdentityPolicy as chronopost } from '../../carriers/chronopost/identity.js';
import { sameInstantIdentityPolicy as ciblex } from '../../carriers/ciblex/identity.js';
import { sameInstantIdentityPolicy as dpd } from '../../carriers/dpd/app.js';
import { sameInstantIdentityPolicy as dpdFrance } from '../../carriers/dpd-fr/identity.js';
import { sameInstantIdentityPolicy as indiaPost } from '../../carriers/india-post/app.js';
import { sameInstantIdentityPolicy as lbcExpress } from '../../carriers/lbc-express/identity.js';
import { sameInstantIdentityPolicy as mondialRelay } from '../../carriers/mondial-relay/identity.js';
import { sameInstantIdentityPolicy as posti } from '../../carriers/posti/identity.js';
import { sameInstantIdentityPolicy as ups } from '../../carriers/ups/app.js';
import { sameInstantIdentityPolicy as swissPost } from '../../carriers/swiss-post/app.js';
import { sameInstantIdentityPolicy as universal } from '../../providers/shared/app.js';

/** Scan evidence available to the app before it reuses a stored identity. */
export interface SameInstantScan {
  readonly stage: string;
  readonly description: string;
  readonly location: string;
  readonly providerCode: string;
}

/** Carrier evidence the parcel app uses when updating a stored scan in place. */
export interface SameInstantIdentityPolicy {
  readonly sourceCarrierId: string;
  readonly storedSources: readonly string[];
  readonly requireProviderCode: boolean;
  /** Match distinct scans sharing an instant by their evidence, with unique matches in both directions. */
  readonly matchEachScan?: boolean;
  readonly matches?: (incoming: SameInstantScan, stored: SameInstantScan) => boolean;
  /**
   * The zone this source once read every wall clock in. A scan showing a wall
   * clock under another offset takes over the stored row whose instant shows
   * that wall clock in this zone, and the reverse, when the provider code
   * (required) and location agree, no event of the batch carries that row,
   * and the match is unique both ways. Wording may differ.
   */
  readonly relabelledFrom?: string;
}

const policies: ReadonlyMap<string, SameInstantIdentityPolicy> = new Map(
  [aliexpress, amazonShipping, australiaPost, chronopost, ciblex, dpd, dpdFrance, indiaPost, lbcExpress, mondialRelay, posti, ups, swissPost, universal].map((policy) => [policy.sourceCarrierId, policy]),
);

/** Unlisted sources cannot identify a reworded scan by its instant alone. */
export function sameInstantIdentityPolicy(
  sourceCarrierId: string,
  options: { supportsScanMatching?: boolean } = {},
): SameInstantIdentityPolicy | undefined {
  const policy = policies.get(sourceCarrierId);
  // Older app versions only check the clock and provider code.
  return policy?.matches && !options.supportsScanMatching ? undefined : policy;
}
