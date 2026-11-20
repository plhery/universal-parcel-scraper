/** China's clock, on which YunExpress dates its rows without a place on China's leg. */
export const YUNEXPRESS_ORIGIN_ZONE = 'Asia/Shanghai';

// Places on China's leg and their clocks: mainland China's, and Hong Kong's, where some parcels leave from.
const ORIGIN_PLACES: readonly (readonly [RegExp, string])[] = [
  [/(?:^|[\s,])(?:CN|China)$/i, YUNEXPRESS_ORIGIN_ZONE], [/(?:^|[\s,])(?:HK|Hong Kong(?: SAR)?)$/i, 'Asia/Hong_Kong'],
];
const originZone = (location: string): string | null => ORIGIN_PLACES.find(([place]) => place.test(location))?.[1] ?? null;
const ARRIVAL = 'international flight has arrived';
// The flight out, in either of YunExpress's wordings.
const DEPARTURES = new Set(['international flight has departed', 'departed from airport']);
/**
 * The destination's import customs rows ("… - Import") and the start of its clearance, which come
 * on the clock of the airport the flight lands at, never China's: the start comes an hour before
 * the completion there, and a US clearance can start while the flight is in the air.
 */
export const YUNEXPRESS_IMPORT_CUSTOMS = /\s-\s?import$|^start customs clear[ae]nce$/;

/**
 * The clock of each of YunExpress's rows, newest first, that China's leg holds without a place, up
 * to the flight out: that of its nearest row with a place, the older one first, when that row is in
 * mainland China or Hong Kong; null for the others. A departure stated as the latest scan carries
 * +08:00, and read on the destination's clock the flight would land hours too soon. Its export
 * clearance and flight out from Hong Kong, unplaced, had the digits its own feed dates +08:00.
 * Import customs rows are not China's.
 */
export function yunExpressOriginLeg(rows: readonly { location: string; wording: string }[]): (string | null)[] {
  const words = rows.map(({ wording }) => wording.replace(/\s+/g, ' ').trim().toLowerCase());
  const arrival = words.lastIndexOf(ARRIVAL);
  const start = rows.findIndex((row, at) => at > arrival && (originZone(row.location) || DEPARTURES.has(words[at]!)));
  return rows.map((row, at) => {
    if (start < 0 || at < start || row.location || YUNEXPRESS_IMPORT_CUSTOMS.test(words[at]!)) return null;
    let place = '';
    for (let older = at + 1; !place && older < rows.length; older += 1) place = rows[older]!.location;
    for (let newer = at - 1; !place && newer >= start; newer -= 1) place = rows[newer]!.location;
    return originZone(place);
  });
}
