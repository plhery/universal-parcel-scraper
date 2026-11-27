# BVC Logistics

BVC Logistics (BVC Logistics Pvt. Ltd.), based in Mumbai, carries valuables such as gems and jewellery, and
e-commerce parcels, across India. Its ValSHIP shipping notes are tracked through the tracking app at
`track2.bvclogistics.com`, an OutSystems app.

## How it works

1. `direct`: the app's current build, read as its page reads it: the module's version from
   `/moduleservices/moduleversioninfo`, the manifest from `/moduleservices/moduleinfo`, and the lookup action's API
   version from the ValSHIP block's script the manifest names. Then a `POST` to
   `/screenservices/Tracking/MainFlow/Valship/ActionGetTrackData` with the shipping note number and OutSystems'
   anonymous visitor token. No account or browser is needed.
2. `retry`: one more attempt when the first fails to reach the app or hangs. The first gets half of the budget, so
   the retry fits in the rest.

- The versions change with each deploy. The adapter keeps them between lookups; when the action says they are
  stale, it reads them again and asks once more. A reply that still names an older build is a schema error, never a
  missing shipment.
- The action lists the numbers it read from the request and the scans it holds for them. An empty scan list beside
  the number asked is not found; a reply about another number is no answer.
- The page's field takes several numbers separated by commas; the adapter sends one, and refuses a comma.

## Notes

- Each row's `Time` is a true UTC instant: the page turns it to the visitor's clock, and on India's clock the
  sample's steps fall where a courier's do, out for delivery late in the morning and delivered in the afternoon,
  with the trunk legs at night. The adapter gives each instant on India's clock.
- A row's `Location` is its step, such as `Origin Hub`; its place is its town, else its hub's name. A row on the road
  names neither.
- The reply mostly lists the rows newest first, but not always; the adapter sorts them by time.

## Limitations

- Only the ValSHIP search is read. The page's other modes are not: iValSHIP, BVC Brinks (a numeric HAWB), EGM
  details by MAWB, and the E-Commerce link, which opens BVC's older tracker at `bvcmars.com`.
- No delivery estimate, weight, service name, sender or recipient.
- Only the wordings in `statuses.json` have been seen; others go through the shared wording rules.

## Numbers

The public sample is a `DS` prefix and seven digits, the shape of R+L Carriers' PRO numbers. One sample does not show
the prefix is BVC's alone, so detection does not offer BVC for it, and the adapter answers explicit selection of any
number of 7 to 30 letters and digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/bvc-logistics` tracks the public sample, or the number in
`BVC_LOGISTICS_TRACKING_NUMBER`, and checks an invented number, or the one in `BVC_LOGISTICS_UNKNOWN_NUMBER`, reads
as not found.
