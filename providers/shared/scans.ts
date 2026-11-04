/**
 * Carrier scan vocabularies for histories a universal provider relays.
 *
 * Some carriers reach us only through aggregators, which pass the carrier's own
 * scan labels through, sometimes machine-translated. When the provider names
 * the carrier of a scan and that carrier has a vocabulary, the label's stage and
 * stored wording come from it rather than from the shared wording rules. A
 * label the carrier files under no stage is `pending`, so it never sets the
 * parcel's stage.
 */
import type { CarrierEvent } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { cdekScan } from '../../carriers/cdek/status.js';
import { chunghwaPostScan } from '../../carriers/chunghwa-post/status.js';
import { emileScan } from '../../carriers/emile/status.js';
import { firstLineScan } from '../../carriers/first-line/status.js';
import { hrvatskaPostaScan } from '../../carriers/hrvatska-posta/status.js';
import { paackScan } from '../../carriers/paack/status.js';
import { sendingScan } from '../../carriers/sending/status.js';
import { ytoScan } from '../../carriers/yto/status.js';

export interface CarrierScan {
  stage: Stage;
  wording: string;
  // The place the label names beside the scan, which the stored wording leaves out.
  location?: string;
  returnLeg?: true;
  // A receipt that, once the item moved on, is a facility further on receiving it.
  receipt?: true;
  // A notice the carrier writes at the instant of a step of this stage, which it is part of.
  partOf?: Stage;
}

const VOCABULARIES: Readonly<Record<string, (label: string) => CarrierScan | undefined>> = {
  cdek: cdekScan,
  'chunghwa-post': chunghwaPostScan,
  emile: emileScan,
  'first-line': firstLineScan,
  'hrvatska-posta': hrvatskaPostaScan,
  paack: paackScan,
  sending: sendingScan,
  yto: ytoScan,
};

/** The vocabulary entry for one relayed label, when its carrier has a vocabulary. */
export function carrierScan(carrier: string | undefined, label: string): CarrierScan | undefined {
  return carrier && Object.hasOwn(VOCABULARIES, carrier) ? VOCABULARIES[carrier]!(label) : undefined;
}

// After a scan that starts the carrier's return, its delivery-side scans are
// the trip back: the sender signing for the parcel is a return, not a delivery.
// A scan reporting a return already finished, such as Emile's, starts nothing.
const RETURN_LEG: Partial<Record<Stage, string>> = {
  out_for_delivery: 'Out for delivery back to the sender',
  ready_for_pickup: 'In a parcel locker or station on its way back',
  delivered: 'Returned to the sender',
};

/**
 * Leaves out a notice written by its carrier at the instant of the step it is part of, as Paack's
 * new attempt beside the failed one; the step stays. `stageOf` reads a scan the vocabulary does not.
 */
export function dropStepNotices<T extends { name: unknown; date: unknown; scan: CarrierScan | undefined; wording: string }>(
  entries: T[], stageOf: (wording: string) => Stage | undefined,
): void {
  const notices = new Set(entries.filter(({ scan }, index) => scan?.partOf && entries.some((other, at) => at !== index
    && !other.scan?.partOf && other.name === entries[index]!.name && other.date === entries[index]!.date
    && (other.scan?.stage ?? stageOf(other.wording)) === scan.partOf)));
  for (let index = entries.length - 1; index >= 0; index--) if (notices.has(entries[index]!)) entries.splice(index, 1);
}

/** Rewrites the delivery-side scans that follow a vocabulary scan starting a return. */
export function markReturnLeg(scans: ReadonlyArray<{ event: CarrierEvent; scan: CarrierScan }>): void {
  const started = scans.filter(({ scan }) => scan.returnLeg)
    .map(({ event }) => event.time ?? '').filter(Boolean).sort()[0];
  if (!started) return;
  for (const { event, scan } of scans) {
    if ((event.time ?? '') < started) continue;
    const wording = RETURN_LEG[scan.stage];
    Object.assign(event, { provider_leg: 'return' }, wording ? { description: wording,
      stage: scan.stage === 'delivered' ? 'returned' : scan.stage } : {});
  }
}

/** Reads a receipt scan after the item moved on as a facility further on receiving it, as the carrier's own tracker does. */
export function markLaterReceipts(scans: ReadonlyArray<{ event: CarrierEvent; scan: CarrierScan }>): void {
  const clock = (event: CarrierEvent) => event.time ?? event.local_time ?? '';
  const moved = scans.filter(({ scan }) => !['pending', 'registered', 'accepted'].includes(scan.stage))
    .map(({ event }) => clock(event)).filter(Boolean).sort()[0];
  if (!moved) return;
  for (const { event, scan } of scans) {
    if (scan.receipt && event.stage === 'accepted' && clock(event) > moved) event.stage = 'in_transit';
  }
}
