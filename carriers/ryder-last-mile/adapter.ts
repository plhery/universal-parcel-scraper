import { dispatchTrackAdapter, type DispatchTrackTenant } from '../high-energy-transport/dispatchtrack.js';
import { ryderEventStage } from './status.js';

export const PROVIDER = 'Ryder Last Mile';

/**
 * Ryder Last Mile on DispatchTrack, under the tenant of MXD Group, which Ryder
 * bought. Its order widget holds a dated event at each milestone, and the
 * snapshot labels an order with DispatchTrack's own number rather than the
 * one a customer is given, so the widget is read on every lookup.
 */
export const RYDER_LAST_MILE: DispatchTrackTenant = {
  carrier: 'ryder-last-mile', provider: PROVIDER, tenant: 'mxd', trackCode: '6b8db72', history: true, eventStage: ryderEventStage,
};

export const adapter = dispatchTrackAdapter(RYDER_LAST_MILE);
