/** China's clock, on which YunExpress dates its rows without a place on China's leg. */
export const YUNEXPRESS_ORIGIN_ZONE = 'Asia/Shanghai';

const IN_CHINA = /(?:^|[\s,])(?:CN|China)$/i;
const ARRIVAL = 'international flight has arrived';
const DEPARTURE = 'international flight has departed';

/**
 * Which of YunExpress's rows, newest first, are rows without a place that China's leg holds, up to
 * the flight out, whose nearest row with a place, the older one first, is in China: they are on
 * China's clock. A departure stated as the latest scan carries +08:00, and read on the
 * destination's clock the flight would land hours too soon.
 */
export function yunExpressOriginLeg(rows: readonly { location: string; wording: string }[]): boolean[] {
  const words = rows.map(({ wording }) => wording.replace(/\s+/g, ' ').trim().toLowerCase());
  const arrival = words.lastIndexOf(ARRIVAL);
  const start = rows.findIndex((row, at) => at > arrival && (IN_CHINA.test(row.location) || words[at] === DEPARTURE));
  return rows.map((row, at) => {
    if (start < 0 || at < start || row.location) return false;
    let place = '';
    for (let older = at + 1; !place && older < rows.length; older += 1) place = rows[older]!.location;
    for (let newer = at - 1; !place && newer >= start; newer -= 1) place = rows[newer]!.location;
    return IN_CHINA.test(place);
  });
}
