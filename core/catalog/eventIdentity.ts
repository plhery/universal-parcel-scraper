import { sameInstantIdentityPolicy as dpd } from '../../carriers/dpd/app.js';
import { sameInstantIdentityPolicy as indiaPost } from '../../carriers/india-post/app.js';

/** Carrier evidence the parcel app uses when updating a stored scan in place. */
export interface SameInstantIdentityPolicy {
  readonly sourceCarrierId: string;
  readonly storedSources: readonly string[];
  readonly requireProviderCode: boolean;
}

const policies: ReadonlyMap<string, SameInstantIdentityPolicy> = new Map(
  [dpd, indiaPost].map((policy) => [policy.sourceCarrierId, policy]),
);

/** Unlisted sources cannot identify a reworded scan by its instant alone. */
export function sameInstantIdentityPolicy(sourceCarrierId: string): SameInstantIdentityPolicy | undefined {
  return policies.get(sourceCarrierId);
}
