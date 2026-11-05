// A US partner's place as the tracker relays GOFO's: its hub's "Town, ST", then the town again and the state,
// "Melrose Park, IL, Melrose Park IL", or the state alone, "Melrose Park, IL IL".
const REPEATED_TOWN = /^(\S[^,]{0,80}), ([A-Z]{2})(?:,? \1)? \2$/;

/** A place as the tracker writes it, without a trailing postcode or a US town and state said twice. */
export function firstLinePlace(location: string): string {
  return location.replace(/\s+\d{4,6}(?:-\d{4})?$/, '').trim().replace(REPEATED_TOWN, '$1, $2');
}
