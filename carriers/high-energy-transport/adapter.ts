import { dispatchTrackAdapter, type DispatchTrackTenant } from './dispatchtrack.js';

export const PROVIDER = 'High Energy Transport';

/**
 * High Energy Transport on DispatchTrack. Its tracker writes no events, so the
 * snapshot alone is read when it labels the order with the number asked.
 */
export const HIGH_ENERGY_TRANSPORT: DispatchTrackTenant = {
  carrier: 'high-energy-transport', provider: PROVIDER, tenant: 'highenergytransport', trackCode: 'f7ea831', history: false,
};

export const adapter = dispatchTrackAdapter(HIGH_ENERGY_TRANSPORT);
