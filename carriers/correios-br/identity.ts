import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// The sending post's posting and office of exchange, which Correios labels with
// Brasília's zone, were read on it until they took the sending country's clock.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'correios-br', storedSources: ['correios-br'], requireProviderCode: true, relabelledFrom: 'America/Sao_Paulo',
};
