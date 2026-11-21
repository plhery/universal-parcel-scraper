# Polar Express

Polar Express (polexp.com) is a New Jersey forwarder that ships parcels bought in the USA and
Canada to Russia, Uzbekistan and other CIS countries. Its site sends customers of its Standard
and pickup-point services to its own tracker, the-tracking.com, which also shows the leg of the
partner that carries the parcel on: Emirates Post's EMS, bpost or Boxberry.

## How it works

1. `direct`: reads `the-tracking.com/<number>/`, a page the server renders. Its parcel
   information table gives the number, the service, the weight and the destination. The history
   is the array the page's script draws, `var timeline_data`, read as data without running it;
   the page's own history table is commented out and empty.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- The tracker's "Not Found" notice is not found. It shows the notice only on an unknown number's
  first look, and after that the parcel table with every field blank and no history, which is not
  found too. A verification page is a challenge, and any other page a schema error.
- The tracker also shows other carriers' numbers, under their name or none and without history.
  The page must name the number asked and a Polar Express service, such as Polar Express (USA)
  or Polar Express (Canada); another service is indeterminate.

## Notes

- Polar Express numbers its parcels PE, nine digits and US or CA. The digits carry no UPU check
  digit, so the numbers only look postal: a low-confidence rule offers Polar Express for that
  layout, and the postal rules still name the few that pass the check digit by chance. Polar
  Express also ships some parcels under Russian Post's and Uzbekistan's post's numbers, which its
  tracker answers too; detection leaves those to the posts.
- Rows keep their wall clock. The page gives no zone, its own rows and its partners' are written
  in different places, and in older records the page's ship date and its first row differ by
  seven or eight hours with the season, so neither clock is known.
- A partner's row names the partner in brackets before its place, "[BPOST] - Machelen": the
  place is the location. A Boxberry pickup point's address after its town is left out.
- Emirates Post's delivery row names whoever took the parcel after "Received by": the adapter
  keeps "Delivered" alone. The partners' numbers, the ship date and the destination town are left
  out; the partners' scans are already on the page.
- Some rows are notices: a delayed flight, or the day the parcel should reach Moscow. They keep
  the stage of the row before.

## Limitations

- No delivery estimate, proof of delivery or offset timestamps.

## Numbers

The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/polar-express`

The live test tracks the first public sample in `numbers.json`; `POLAR_EXPRESS_TRACKING_NUMBER`
tracks another number, and `POLAR_EXPRESS_UNKNOWN_NUMBER` checks the not-found answer.
