import type { Stage } from '../../core/status/index.js';
// Exact states in the official public seller tracking feed.
const STAGES: Readonly<Record<string, Stage>> = {
  'data received': 'registered', 'out for pickup': 'registered', 'pickup scheduled': 'registered',
  picked: 'accepted', pickdone: 'accepted', 'picked up': 'accepted',
  intransit: 'in_transit', 'in transit': 'in_transit', 'reached at destination': 'in_transit',
  'out for delivery': 'out_for_delivery', delivered: 'delivered',
  'wrong pincode': 'exception', 'return undelivered': 'failed_attempt', 'rto undelivered': 'failed_attempt',
  rto: 'exception', 'return to origin': 'exception', 'return to origin intransit': 'in_transit', 'rto in transit': 'in_transit', 'reached at origin': 'in_transit',
  'return to origin out for delivery': 'out_for_delivery', 'rto out for delivery': 'out_for_delivery',
  'rto delivered': 'returned', 'return delivered': 'returned',
};
export function xpressbeesStage(raw: string): Stage | undefined {
  return STAGES[raw.toLowerCase().replace(/[-_]/g, ' ').trim().replace(/\s+/g, ' ')];
}
