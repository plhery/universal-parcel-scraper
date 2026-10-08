/**
 * PostNL status vocabulary.
 *
 * Every event carries a `category` token next to its localized
 * `status_description`. Categories are the primary signal. The English
 * labels refine the overloaded Processing, Transit and Customs categories,
 * which also cover sorting, acceptance and customs release.
 * Categories are matched case-insensitively after trimming, because the
 * international tracker has been seen returning them capitalized
 * ("Pre-advised") and lower case in the same history.
 *
 * `unsuccesfull` is PostNL's own spelling; the corrected spelling is mapped
 * alongside it so a fix upstream does not silently lose the classification.
 */
import type { ClassifiedStatus } from '../../core/status/index.js';

const CATEGORY_STATUS = new Map<string, ClassifiedStatus>([
  ['pre-advised', { status: 'pending', stage: 'registered' }],
  ['preparing', { status: 'pending', stage: 'registered' }],
  ['processing', { status: 'in_transit', stage: 'accepted' }],
  ['departed', { status: 'in_transit', stage: 'in_transit' }],
  ['arrived', { status: 'in_transit', stage: 'in_transit' }],
  ['in transit', { status: 'in_transit', stage: 'in_transit' }],
  ['transit', { status: 'in_transit', stage: 'in_transit' }],
  ['customs', { status: 'in_transit', stage: 'customs' }],
  ['out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['pick-up point', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['delivered', { status: 'delivered', stage: 'delivered' }],
  ['unsuccesfull', { status: 'exception', stage: 'failed_attempt' }],
  ['unsuccessful', { status: 'exception', stage: 'failed_attempt' }],
  ['undelivered', { status: 'exception', stage: 'failed_attempt' }],
  ['returned', { status: 'exception', stage: 'returned' }],
  ['exception', { status: 'exception', stage: 'exception' }],
]);

export { CATEGORY_STATUS as POSTNL_STATUS };

const IN_TRANSIT: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };

/** Exact English labels that refine an overloaded category, lowercase without final punctuation. */
const LABEL_STATUS = new Map<string, ReadonlyMap<string, ClassifiedStatus>>([
  ['customs', new Map([['the item is released by customs', IN_TRANSIT]])],
  ['processing', new Map([
    ['the item has arrived at the domestic sorting centre', IN_TRANSIT],
    ['the item is at the local sorting centre', IN_TRANSIT],
    ['the item is on transport to the local sorting centre', IN_TRANSIT],
    ['the item is at the local delivery office', IN_TRANSIT],
    ['driver is en route to the pickup location', IN_TRANSIT],
    ['the item is out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ])],
  // PostNL's own acceptance scans.
  ['transit', new Map(['consignment received at the postnl acceptance centre',
    'the shipment is handed over in bulk final acceptance of the item to be confirmed',
  ].map((label): [string, ClassifiedStatus] => [label, { status: 'in_transit', stage: 'accepted' }]))],
  // "Will be returned" can still end in a new delivery attempt; these two are the return itself.
  ['undelivered', new Map(['undeliverable item, has been returned to shipper', 'the item has been returned and arrived at postnl',
  ].map((label): [string, ClassifiedStatus] => [label, { status: 'exception', stage: 'returned' }]))],
]);

/** The status and stage for one PostNL event category, or undefined when unmapped. */
export function postNLStatus(category: unknown, description?: unknown): ClassifiedStatus | undefined {
  const code = (typeof category === 'string' ? category : '').trim().toLocaleLowerCase('en-US');
  const label = (typeof description === 'string' ? description : '').trim().toLocaleLowerCase('en-US').replace(/[.!]+$/, '');
  return LABEL_STATUS.get(code)?.get(label) ?? CATEGORY_STATUS.get(code);
}
