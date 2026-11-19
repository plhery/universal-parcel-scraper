/** A Chronopost scan 17TRACK gives no location, written as its office in capitals and its label: "EXAMPLE CEDEX, Shipment in transit". */
const OFFICE_LABEL = /^(\p{Lu}[\p{Lu}\p{N} '’./-]{1,79}), (\S.*)$/u;

/**
 * A Chronopost scan (17TRACK's carrier 100273) as Chronopost's own result gives it: its label at
 * its office (carriers/chronopost). 17TRACK writes the office and the label as the location
 * ("EXAMPLE CEDEX, Shipment handed over by the sender"), and both, then the scan's extra fields (a
 * partner's number, the pickup point) as the description; with no location, the description
 * starts with the office. Chronopost's result keeps those fields out of the label, and so does
 * this. Null when the scan is not in either shape.
 */
export function chronopostOfficeLabel(location: string, description: string): { location: string; description: string } | null {
  if (!location) {
    const office = OFFICE_LABEL.exec(description);
    return office ? { location: office[1]!, description: office[2]! } : null;
  }
  const comma = location.indexOf(', ');
  if (comma < 1 || location.includes(', ', comma + 2) || (description !== location && !description.startsWith(`${location}, `))) return null;
  return { location: location.slice(0, comma), description: location.slice(comma + 2) };
}
