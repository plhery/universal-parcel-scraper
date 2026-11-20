import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Scans abroad kept the UK offset Royal Mail labels them with until October
// 2026, then showed their country's. A European partner's scans now show
// Central European time in summer and UTC in winter, and those beyond Europe
// the UK offset again.
// One tracker answers for both brands, so a parcel's scans can be stored under
// either: each policy reads the other's rows as the same scans.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'royal-mail', storedSources: ['royal-mail', 'parcelforce'], requireProviderCode: true, relabelledFrom: 'Europe/London',
};

/** Parcelforce's parcels, which Royal Mail's tracker answers and labels the same way. */
export const parcelforceIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'parcelforce', storedSources: ['parcelforce', 'royal-mail'], requireProviderCode: true, relabelledFrom: 'Europe/London',
};
