// The places rows name in their wording: the origin's town, with its state and country, ahead of
// or inside the words; the origin hub in brackets; the country of the airport or facility the
// parcel reached; the town the delivery station serves, or its own town and area, before its postcode.
const PLACES: readonly ((wording: string) => string | undefined)[] = [
  (wording) => /^(.+?),([A-Z]{2}),([A-Z]{2}),[^,]+,Order information received by the carrier\.?$/.exec(wording)?.slice(1).join(', '),
  (wording) => {
    const match = /^Consignment received at the local warehouse in ([A-Z]{2}),([A-Z]{2}),[^,]+,(.+)\.$/.exec(wording);
    return match ? `${match[3]}, ${match[1]}, ${match[2]}` : undefined;
  },
  (wording) => /^Origin processing completed \[(.+)\]\.$/.exec(wording)?.[1],
  (wording) => /^Shipment arrived at (?:the )?([A-Z]{2}) (?:Airport|destination processing facility\.)$/.exec(wording)?.[1],
  (wording) => /, serving (.+?),\d{4,5}\.$/.exec(wording)?.[1],
  (wording) => /^Arrived at the delivery station ([^,]{1,60}),([^,\d]{1,60}),\d{4,5}\.?$/.exec(wording)?.slice(1).join(', '),
  // The other line's hub, town or country, in brackets before, among or after the words
  // ("About to be sent to the [Example] warehouse").
  (wording) => /(?:^| )\[([^\]]{1,60})\](?: |\.?$)/.exec(wording)?.[1],
];

/** The place a row's wording names, if any. */
export function jetspeedPlace(wording: string): string | undefined {
  for (const read of PLACES) {
    const place = read(wording)?.trim();
    if (place) return place;
  }
  return undefined;
}
