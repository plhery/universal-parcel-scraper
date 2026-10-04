import { sameInstantIdentityPolicy as dpd } from '../../carriers/dpd/app.js';
import { sameInstantIdentityPolicy as indiaPost } from '../../carriers/india-post/app.js';
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
}

const policies: ReadonlyMap<string, SameInstantIdentityPolicy> = new Map(
  [dpd, indiaPost, ups, swissPost, universal].map((policy) => [policy.sourceCarrierId, policy]),
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
