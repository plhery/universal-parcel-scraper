/**
 * PostNL's customs stamps, which its own feed dates as UTC instants to the fraction of a second wherever it dates
 * its other scans locally (adapter.ts). Universal providers that copy them give their UTC digits.
 */
export const POSTNL_CUSTOMS_STAMP = /^(?:pre-declaration of the item has been received|item is cleared|duties and taxes confirmed) by customs$/i;

/**
 * PostNL's acceptance and bagging stamps. Its own feed dates them as UTC instants to the fraction of a second when its
 * acceptance centre stamps them, and to the minute on the local clock otherwise. Universal providers drop the fraction
 * and keep the seconds, so a copy with seconds has the UTC digits.
 */
export const POSTNL_ACCEPTANCE_STAMP = /^(?:consignment received at the postnl acceptance centre|item is nested to commercial bag|item is being processed)$/i;

/**
 * PostNL's own records that its feed keeps on UTC when they name no place (`postnlRecordZone`): the label's creation
 * and the processing record. Universal providers that copy them give their UTC digits.
 */
export const POSTNL_UTC_RECORD = /^(?:the shipping label has been created|the item is being processed)[.!]?$/i;
