/**
 * DHL eCommerce Poland status vocabulary.
 *
 * The portal sends a status code and the step of its four-point timeline.
 * `statuses.json` holds the codes whose meaning the page script or a live
 * answer establishes. Any other code takes the stage of its timeline step.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage?: Stage }

const CODES = new Map<string, Entry>(statuses.entries.map((entry) => [entry.code, { wording: entry.wording, stage: entry.stage as Stage }]));

// The timeline steps with the English labels the page gives them. `None` is a
// label that was created and not posted yet: it names no stage.
const TIMELINE: Record<string, Entry> = {
  None: { wording: 'Shipment preparation' },
  Sent: { wording: 'Posted', stage: 'registered' },
  Route: { wording: 'On its way', stage: 'in_transit' },
  Delivery: { wording: 'For delivery', stage: 'out_for_delivery' },
  Delivered: { wording: 'Delivered', stage: 'delivered' },
  ReturnToSender: { wording: 'Return to the Sender', stage: 'returned' },
  DeliveredToSender: { wording: 'Delivered to the Sender', stage: 'returned' },
  Resigned: { wording: 'The sender has requested the withdrawal of the shipment', stage: 'exception' },
  Error: { wording: 'Error', stage: 'exception' },
};

const STATUSES: Record<Stage, CarrierStatus> = {
  pending: 'pending', registered: 'pending', accepted: 'in_transit', in_transit: 'in_transit', customs: 'in_transit',
  ready_for_pickup: 'in_transit', out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  failed_attempt: 'exception', returned: 'exception', exception: 'exception',
};

export interface DhlEcommercePlStatus { description: string; stage?: Stage }

/** `text` is the sentence the answer carries for the status, when it has one. */
export function dhlEcommercePlStatus(code: string, timelineStep: unknown, text = ''): DhlEcommercePlStatus {
  const known = CODES.get(code);
  const step = typeof timelineStep === 'string' && Object.hasOwn(TIMELINE, timelineStep) ? TIMELINE[timelineStep] : undefined;
  const stage = known?.stage ?? step?.stage;
  const words = code.replaceAll('_', ' ').toLowerCase();
  return { description: text || known?.wording || step?.wording || words.charAt(0).toUpperCase() + words.slice(1), ...(stage ? { stage } : {}) };
}

export function statusForStage(stage: Stage): CarrierStatus {
  return STATUSES[stage];
}
