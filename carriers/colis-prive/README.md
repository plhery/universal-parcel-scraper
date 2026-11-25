# Colis Privé

French private parcel network (door, relay point, locker), also delivering in
Belgium and Luxembourg. Tracked by parsing
the public "Mon Colis" detail page, which needs the shipment number plus the
recipient's postcode.

## How it works

1. `direct`: one GET of
   `https://www.colisprive.com/moncolis/pages/DetailColis.aspx?numColis={number}{postcode}&lang=fr`
   with `redirect: 'manual'`. No session, token or JSON feed: the page is
   server-rendered HTML.
   - A 404 or any other 3xx is not-found (`ColisPriveTrackingError`): an
     unknown shipment is bounced to the search page instead of answering 404.
   - A redirect to the same page and query on another `colisprive.com` host is
     followed once: the bare domain sends every request to `www` with a 308,
     which is the site moving, not the not-found bounce.
   - Other non-2xx statuses throw `UpstreamHttpError`.
2. `parse()` reads `.divDesti`, the recipient's name and address, then removes it,
   requires the `.BandeauInfoColis` banner, checks the displayed 12-character number
   matches the credential, then reads the status banner and timeline rows.

## Notes

- The credential is 12 alphanumerics followed by the recipient's postcode:
  five digits in France, four in Belgium, bare or after `B`, or `L` and four
  digits in Luxembourg. Luxembourg's four digits without the `L` are passed on
  but unconfirmed. Colis Privé's own links carry it as one value, and its search form
  asks for the postcode in a separate field. The adapter takes either: the
  postcode at the end of the number, or a bare 12-character number with the
  `postcode` input. A written prefix such as `B-1000` or `LU 1234` becomes the
  letter. The page never opens without the postcode, so a bare number with no
  postcode is `input_required`.
- Twelve characters, or twelve and five digits, are printed by carriers everywhere. Colis Privé
  delivers only in France, Belgium and Luxembourg, so recognition asks it about them for a
  reader elsewhere only once every other candidate has missed (`servedCountriesOnly`).
- Twelve digits from `51` or `52` followed by a French postcode have been Colis Privé's on every
  parcel seen, like the forum's numbers in `numbers.json`, and no other carrier's rule takes them,
  so `colis-prive-3` names Colis Privé with high confidence and recognition is not asked. Colis
  Privé often holds such a label only hours after it is printed, after recognition has given up.
- The postcode is what opens the page, so treat the whole value as a secret:
  never log it, quote it in an issue or put it in a fixture or `numbers.json`.
  The corpus keeps bare 12-character numbers only.
- Detection takes the twelve characters only as at most two letters and then digits, the
  shape of every known number. Three letters or more open other carriers' numbers, such as
  Yanwen's `YW` with a hub code, YWE, BYT, GOFO's `GF` or `CI` with a country code, Cainiao's
  `CNG` and DobroPost's `DBRPST`, even when they end in five digits. The adapter still takes
  any twelve letters and digits from a link or a chosen carrier.
- `.divDesti` lists the recipient's name, street, and postcode and town, one per line. It is
  read on its own and then removed, not filtered afterwards: a later selector can forget a
  filter, not a removal.
- A page for another shipment is a schema error, never a result.
- The timeline prints `DD/MM/YYYY` with no clock, so each scan keeps its day alone in
  `local_time` and the catalog marks its scans as dated by day by design. `dateKey()`
  rejects impossible dates. Same-day events keep page order.
- The status banner can lag the timeline. A banner repeating an older row's wording while the
  newest row says something else gives way to the newest row, as the status and its text.
- Wording only, no status codes. Exception and return phrases are checked before
  delivery ones, because "nous avons tenté de livrer" contains "livrer".
- "subi un retard" maps to `failed_attempt`.
- Rows announcing a confirmed appointment or a relay drop-off end with the
  planned day, which becomes the delivery estimate. It is dropped once the
  parcel is delivered, waiting, held or returned, or a later row passes it.
- Unmatched wording gets no stage; the sync classifies it and records it for
  review.
- `ColisPriveTrackingError` stays a named `NotFoundError` subclass: host sync
  tests and the live suite match on its name, and `error_type` is a Sentry label.

## Rejected approaches

- Accepting the postcode only as a separate input: the combined value is what
  stored parcels and Colis Privé's links hold, so both forms stay accepted.
- Detecting the 12-plus-four-digit form from a typed number: any 16-character
  number ending in four digits would suggest Colis Privé. It arrives through
  Colis Privé's links or a chosen carrier instead.
- Treating the 3xx bounce as a transport failure: it is the provider's stable
  not-found answer.

## Limitations

- The page has no scan location or weight.
- Undocumented HTML; markup changes fail loudly as schema errors.

## Testing

`npm run test:carriers:live -- testing/frenchDirectCarriers.live.test.ts`
(no env vars) checks a wrong number maps to a clean not-found.
