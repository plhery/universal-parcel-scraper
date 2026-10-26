# TNT

Direct tracking covers 9-digit international consignments through the JSON read
behind tnt.com's public tracking page, and TNT France's 16-digit national
consignments through its public HTML tracking page.

## How it works

`direct` makes one GET, chosen by the number's shape. No session, browser,
postcode or account is required.

- 9 digits: `https://www.tnt.com/api/v3/shipment?con={number}&searchType=CON&locale=en_GB&channel=OPENTRACK`.
  A `notFound` entry for the number is a clean not-found, which recognition uses.
- `GE`, 9 digits and `WW`: the same request for the 9 digits. ExpressConnect's guide and
  tnt.it's tracking guide print consignments this way, with or without the letters.
- 16 digits: the national consignment detail page on tnt.fr. tnt.com rejects these
  numbers, so they are never sent there.

## Notes

- Local detection accepts both consignment checks in
  [ExpressConnect's Appendix I](https://express.tnt.com/expresswebservices-website/docs/ExpressConnect%20Shipping%20Integration%20Guide%20v3.7.pdf).
  A passing check prioritizes a candidate without confirming a shipment. The
  international checks do not apply to French national references.
- Detection names TNT for `GE`, 9 digits and `WW` when the 9 digits pass the modulus 11
  check. `WW` is no country, so no post issues the code. A country code in place of `WW`,
  as ExpressConnect's examples also print, stays with the generic postal carrier: posts
  issue `G` series codes too.
- A tnt.com tracking link names TNT for the consignment in its `cons` parameter.
- tnt.com lists every consignment that carried the number, since numbers are reused.
  Only consignments whose own number matches are read, and the one with the most recent
  scan is the parcel. References, signatories and addresses are not kept, except the
  destination's country: its `countryCode`, or else its name, becomes
  `destination_country` (or `destination_country_name` for a name without an ISO code).
- tnt.com scan times carry offsets. Scan codes (`legacyCode`) set the stage, because the
  wording is prose: "partially delivered" is not a delivery, and a residential delivery
  (`RES`) reads like `OK`. The estimate is kept as a calendar day until delivery.
  Customs release returns to transit even when the wording still mentions customs.
- tnt.com enters some transit scans at their planned time, before they happen. A scan dated
  more than five minutes after the lookup is held back until it is due (`plannedScans`).
- A shipment either site lists without scans is a `NoHistoryError`: TNT knows the label
  but has not scanned it yet, which is an answer about the parcel, not an outage.
- On tnt.fr, the returned detail header and item identity must match. History comes only
  from the shipment's event rows; the progress rail includes future delivery labels.
  The selected milestone determines current status. National scan times are read in the
  French civil timezone, and the page's Latin-1 encoding is respected.

## Limitations

The link opens tnt.com, which cannot show TNT France consignments. Public histories can
expire.

## Testing

Set `TNT_TRACKING_NUMBER` (9 digits) or `TNT_FRANCE_TRACKING_NUMBER` (16 digits) outside
the repository, then run `npm run test:carriers:live -- carriers/tnt`.
The wrong-number check runs without either.
