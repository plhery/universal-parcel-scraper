/**
 * The feeds Ordertracker relays each catalog carrier's scans through, by the name its events
 * give the feed (`events[].carrier.name`), the one whose clock and words to prefer first.
 * Ordertracker writes every time as UTC: a `utc` feed's times are instants, a `local` feed's
 * are the scanning place's wall clock. Listed are carriers whose public numbers Ordertracker
 * answered through these feeds with the scans the carrier's own tracking shows, clock for
 * clock. Ask the benchmark's numbers through the endpoint and compare them with the
 * carrier's adapter before adding one.
 */
export interface OrdertrackerFeed {
  name: string;
  clock: 'utc' | 'local';
  /**
   * How a scan's lines read: `wording` is the scan's wording alone; `place_line` gives the
   * place on a line of its own after the wording, or alone when the feed lost the wording;
   * `bracketed_place` the same with the place in brackets; `trailing_place` one line with
   * the town and country code after the wording, then any detail.
   */
  lines: 'wording' | 'place_line' | 'bracketed_place' | 'trailing_place';
  /**
   * A `utc` feed that writes a scan its carrier dates by its day alone at midnight UTC, as
   * Mail Boxes Etc writes FedEx's pickup. A `local` feed's scan at midnight is read as its day.
   */
  daysAtMidnight?: true;
  /**
   * A `utc` feed that writes a scan at a place east of Greenwich on that place's wall clock, as
   * if the plus sign of the carrier's offset were lost: Mail Boxes Etc writes FedEx's scans in
   * Europe an hour late in winter, and those in the Americas, and the label without a place, at
   * their instants.
   */
  wallClockEast?: true;
}

const LA_POSTE: OrdertrackerFeed = { name: 'LA POSTE', clock: 'utc', lines: 'wording' };
const PITNEY_BOWES: OrdertrackerFeed = { name: 'PITNEY BOWES', clock: 'local', lines: 'place_line' };

const FEEDS: Readonly<Record<string, readonly OrdertrackerFeed[]>> = {
  // Pitney Bowes repeats some scans in English where Canada Post's own feed has only French.
  'canada-post': [{ name: 'CANADA POST', clock: 'utc', lines: 'place_line' }, PITNEY_BOWES],
  chronopost: [LA_POSTE],
  fedex: [{ name: 'MAIL BOXES ETC', clock: 'utc', lines: 'trailing_place', daysAtMidnight: true, wallClockEast: true }],
  'la-poste': [LA_POSTE],
  // Each scan comes through both, Pitney Bowes's copy with the seconds and FAR's with the wording it can lose.
  ups: [PITNEY_BOWES, { name: 'FAR', clock: 'local', lines: 'bracketed_place' }],
  usps: [PITNEY_BOWES],
};

/** The feeds whose scans answer for `carrier`, when Ordertracker's answers for it were checked. */
export function ordertrackerFeeds(carrier: string | null | undefined): readonly OrdertrackerFeed[] | undefined {
  return carrier && Object.hasOwn(FEEDS, carrier) ? FEEDS[carrier] : undefined;
}

/** The carriers Ordertracker is asked about. */
export const ORDERTRACKER_CARRIERS: readonly string[] = Object.keys(FEEDS);
