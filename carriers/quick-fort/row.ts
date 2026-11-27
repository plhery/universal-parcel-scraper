// How Quick Fort writes a row's place, read by its parser and by 17TRACK, which copies its rows whole.

// A place's parts: a postcode, a two-letter region or country code, or a name of at most three words.
const POSTCODE = /^(?=[A-Z0-9 -]*\d)[A-Z0-9][A-Z0-9 -]{1,9}$/;
const CODE = /^[A-Z]{2}$/;
const NAME = /^\p{L}[\p{L}\p{M}'’-]*(?: [\p{L}\p{M}'’-]+){0,2}$/u;
// A town written after its postcode in the same part: "03195 Alicante".
const POSTCODE_TOWN = /^\d{3,6} (\p{L}[\p{L}\p{M}'’-]*(?: [\p{L}\p{M}'’-]+){0,2})$/u;

/** A comma-separated place without its postcode, names first; undefined when it holds no code or postcode, or a part of no place. */
function placeOf(text: string): string | undefined {
  const parts = text.split(',').map(part => part.trim()).filter(Boolean).map(part => POSTCODE_TOWN.exec(part)?.[1] ?? part);
  if (!parts.some(part => POSTCODE.test(part) || CODE.test(part))) return undefined;
  if (!parts.every(part => POSTCODE.test(part) || CODE.test(part) || NAME.test(part))) return undefined;
  const names = parts.filter(part => !CODE.test(part) && !POSTCODE.test(part));
  return [...names, ...parts.filter(part => CODE.test(part))].join(', ');
}

// The English delivery row ends with the recipient's street and house number ("Delivered <street> 8/1").
const ADDRESS_AFTER_DELIVERY = /^(delivered)\s+(?=.*\d).+$/i;

/** A row's sentence, and the place written before, within or after it, which can hold a postcode. */
export function quickFortRow(text: string): { description: string; location?: string } {
  const placed = (description: string, location: string) =>
    ({ description: description.replace(ADDRESS_AFTER_DELIVERY, '$1'), ...(location ? { location } : {}) });
  const before = /^((?:[^,.]{1,40},){2,6})\s*(\S.*)$/.exec(text);
  const leading = before ? placeOf(before[1]!) : undefined;
  if (before && leading !== undefined) return placed(before[2]!, leading);
  // The English rows' place after "in" or ", serving": "Out for delivery in <town>,<postcode>,DE".
  const within = /^(.*?)(?: in|, serving) ((?:[^,.]{1,40},){1,5}[^,.]{1,40})(\.?)$/.exec(text);
  const inner = within ? placeOf(within[2]!) : undefined;
  if (within && inner !== undefined) return placed(within[1]! + within[3]!, inner);
  const after = /^(.*[.!?])\s*([^.!?]*,[^.!?]*?)\.?$/.exec(text);
  const trailing = after ? placeOf(after[2]!) : undefined;
  if (after && trailing !== undefined) return placed(after[1]!, trailing);
  return placed(text, '');
}
