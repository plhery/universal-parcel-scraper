import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Every Hermes scan carries its `parcelStatus` code. A scan without
// `historyText` reads "Hermes tracking update" while its code is unmapped and
// the code's own description once it is mapped; that new wording keeps its
// stored row at the same instant, matched by the code.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'hermes-de', storedSources: ['hermes-de'], requireProviderCode: true,
};
