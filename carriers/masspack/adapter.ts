import { auOps, AuOpsTracker, type AuOpsTenant } from './auOps.js';

/** Masspack's tenant of the AU-OPS platform, which its public tracker names by this host. */
export const MASSPACK: AuOpsTenant = { id: 'masspack', host: 'mp.masspack-express.com' };

/** A tracker of Masspack's orders, with the supplied transport. */
export const masspackTracker = (options: ConstructorParameters<typeof AuOpsTracker>[1] = {}) => new AuOpsTracker(MASSPACK, options);

export const adapter = auOps(MASSPACK);
