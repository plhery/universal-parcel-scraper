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
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

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
  ['transit', new Map([
    // PostNL's own acceptance scans.
    ...['consignment received at the postnl acceptance centre',
      'the shipment is handed over in bulk final acceptance of the item to be confirmed',
    ].map((label): [string, ClassifiedStatus] => [label, { status: 'in_transit', stage: 'accepted' }]),
    // The customs declaration filed ahead of the item, usually before PostNL has it: its data, not a scan.
    ['pre-declaration of the item has been received by customs', { status: 'pending', stage: 'registered' }],
  ])],
  // "Will be returned" can still end in a new delivery attempt; these two are the return itself.
  ['undelivered', new Map(['undeliverable item, has been returned to shipper', 'the item has been returned and arrived at postnl',
  ].map((label): [string, ClassifiedStatus] => [label, { status: 'exception', stage: 'returned' }]))],
]);

/**
 * Scans their status number stages, whatever their wording. PostNL's acceptance: 173 is the
 * acceptance centre's receipt and 3116 the bulk handover, and a universal provider relays 3116 as
 * "Arrive at transit country or district". Under Preparing, whose other statuses come before PostNL
 * has the item, 3179 ("Item is being processed") is the sorting centre's step after the acceptance,
 * seconds before 3178 bags the item.
 */
const CODE_STATUS = new Map<string, ReadonlyMap<string, ClassifiedStatus>>([
  ['transit', new Map(['173', '3116'].map((code): [string, ClassifiedStatus] => [code, { status: 'in_transit', stage: 'accepted' }]))],
  ['preparing', new Map([['3179', IN_TRANSIT]])],
]);

/** A category as the maps key it: trimmed, in lower case. */
function categoryKey(category: unknown): string {
  return (typeof category === 'string' ? category : '').trim().toLocaleLowerCase('en-US');
}

/** The status and stage for one PostNL event category, its label and status number, or undefined when unmapped. */
export function postNLStatus(category: unknown, description?: unknown, status?: string): ClassifiedStatus | undefined {
  const code = categoryKey(category);
  const label = (typeof description === 'string' ? description : '').trim().toLocaleLowerCase('en-US').replace(/[.!]+$/, '');
  return LABEL_STATUS.get(code)?.get(label) ?? (status ? CODE_STATUS.get(code)?.get(status) : undefined) ?? CATEGORY_STATUS.get(code);
}

/**
 * Labels of PostNL's domestic tracker seen on parcels, lowercase without final
 * punctuation: those the shared wording rules read wrong, and its pre-advice and
 * sorting scans.
 * Its observations carry no category.
 */
const DOMESTIC_STAGE = new Map<string, Stage>([
  ['shipment expected, but not yet arrived or processed at postnl', 'registered'],
  ['not yet processed by postnl', 'registered'],
  ['shipment received by postnl', 'accepted'],
  ['driver is en route', 'out_for_delivery'],
  ['shipment sorted in sorting centre', 'in_transit'],
  ['shipment has been sorted', 'in_transit'],
  ['shipment is ready for transport to the country of destination', 'in_transit'],
  // A parcel PostNL delivers abroad: the border, the destination's sorting centre, then its rounds.
  ['your parcel has crossed the border', 'in_transit'],
  ["your parcel's at a sorting centre in the destination country", 'in_transit'],
  ['your shipment is on its way to the recipient', 'out_for_delivery'],
  ["we missed you; we'll try again", 'failed_attempt'],
  // A new delivery day, the morning after PostNL received the parcel and before any round: a delay, not an attempt.
  ["sorry, delivery time has been updated. we're unable to deliver your parcel today", 'in_transit'],
]);

/** The stage of one domestic tracker observation, or undefined when unmapped. Its labels write the apostrophe either way. */
export function postNLDomesticStage(description: string): Stage | undefined {
  return DOMESTIC_STAGE.get(labelKey(description));
}

/**
 * International item scans a universal provider relays without their category, lowercase without
 * final punctuation: statuses 3070, 8, 101 and 3178, which the Transit category stages, and 134,
 * which the Arrived category stages.
 */
const RELAYED_STAGE = new Map<string, Stage>([
  ['the item is received by postnl', 'in_transit'],
  ['the item is at the postnl sorting center', 'in_transit'],
  ['the item is processed at the postnl sorting center', 'in_transit'],
  // The item bagged for its line after the sorting centre (status 3178).
  ['item is nested to commercial bag', 'in_transit'],
  // The item in its destination country, before the post there receives it (status 134).
  ['the item has arrived in the country of destination', 'in_transit'],
  // FedEx International Connect's scans on the line it carries, as its own map reads its codes 198, 200 and 222.
  ['accepted at fedex processing centre', 'accepted'],
  ['shipment manifested for departure', 'in_transit'],
  ['departed site', 'in_transit'],
]);

function labelKey(description: string): string {
  return description.trim().toLocaleLowerCase('en-US').replace(/[.!]+$/, '').replace(/\u2019/g, "'");
}

/**
 * An international scan's provider code: its status number, a slash and its category as the map
 * keys it ("37/delivered"), since the category stages the scan. A scan without a category keeps
 * its number alone.
 */
export function postNLCode(status: string, category: unknown): string {
  const key = categoryKey(category).slice(0, 64);
  return key ? `${status}/${key}` : status;
}

/**
 * What the map says about one scan. An international scan stored with its category is staged by
 * that category, its label (the stored wording) and its status number, as the adapter stages it.
 * A domestic observation, or an international scan stored with its status number alone, is read by the
 * domestic tracker's labels, whole, as a universal provider relays them under PostNL's name, and by the
 * international item scans it relays without their category.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const [, status, category] = /^(\d{1,8})\/(.+)$/s.exec(code ?? '') ?? [];
    return category === undefined ? postNLDomesticStage(wording) ?? RELAYED_STAGE.get(labelKey(wording))
      : postNLStatus(category, wording, status)?.stage;
  },
  gaps: [],
  wholeWording: true,
};
