import { AmazonShippingTracker, type AmazonShippingOptions } from './adapter.js';
import { CarrierError } from '../../core/errors/index.js';

/** A public eligibility check; transport errors remain errors for the consumer to report. */
export async function amazonShippingEligibility(number: string, options: AmazonShippingOptions = {}): Promise<'available' | 'expired' | 'not-found'> {
  try {
    await new AmazonShippingTracker({ ...options, timeoutMs: options.timeoutMs ?? 5_000 }).fetch(number);
    return 'available';
  } catch (error) {
    if (error instanceof CarrierError && error.reason === 'history_expired') return 'expired';
    if (error instanceof CarrierError && error.reason === 'shipment_not_found') return 'not-found';
    throw error;
  }
}
