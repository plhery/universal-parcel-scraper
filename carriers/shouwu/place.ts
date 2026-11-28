// The country's code a facility's name can open with, as in "CN,SAMPLE Sort Facility", or the
// empty one before a last mile's town, as in ",SAMPLE TOWN".
const COUNTRY_PREFIX = /^(?:[A-Z]{2})?,(?=\p{L})/u;
// The town, state, country and postcode FedEx's rows open with, as Shouwu relays them:
// "SAMPLE TOWN, CA, US, 00000, Arrived at FedEx location". The postcode has a digit.
const RELAYED_PLACE = /^\p{L}[\p{L}\p{M} .'’-]{0,59}, [A-Z]{2}, [A-Z]{2}, (?:(?=[A-Z\d -]*\d)[A-Z\d][A-Z\d -]{1,8}[A-Z\d], )?(?=\p{L})/u;

/** A scan's place without the country's code it opens with: the facility's or the town's name. */
export function withoutCountryCode(location: string): string {
  return location.replace(COUNTRY_PREFIX, '');
}

/** A scan's wording without the town, state, country and postcode a relayed FedEx row opens with. */
export function withoutRelayedPlace(description: string): string {
  return description.replace(RELAYED_PLACE, '');
}

// The last mile's note after a scan, which can repeat it: "Delivery failed, Carrier note: Delivery failed".
const REPEATING_NOTE = /^(.+), Carrier note: (.+)$/;

/**
 * A scan's wording said once: a line's milestone title followed by the same words as its description, as
 * "Out for delivery Out for delivery", or a scan whose last mile's note repeats it.
 */
export function withoutRepeat(description: string): string {
  const words = description.replace(/\s+/g, ' ').trim();
  const half = (words.length - 1) / 2;
  if (half > 0 && Number.isInteger(half) && words[half] === ' ' && words.slice(0, half) === words.slice(half + 1)) return words.slice(0, half);
  const note = REPEATING_NOTE.exec(words);
  return note && note[1] === note[2] ? note[1]! : description;
}

// An e-mail address a last mile's notice names, the recipient's, with the "to" before it: "Predict information sent
// to: …" reads "Predict information sent".
const EMAIL = /(?:\s+to)?\s*[:：]?\s*[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** A scan's wording without an e-mail address it names. */
export function withoutEmail(description: string): string {
  const cut = description.replace(EMAIL, '');
  return cut === description ? description : cut.replace(/\s+/g, ' ').trim();
}
