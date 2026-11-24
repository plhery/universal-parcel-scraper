# LATAM Cargo

LATAM Cargo is the cargo arm of LATAM Airlines Group, based in Santiago, with freighters and the holds
of passenger flights across South America and to North America and Europe. In Brazil it also carries
domestic courier and e-commerce shipments under service orders.

## How it works

1. `direct`: posts the document's prefix, serial and type as JSON to
   `latamcargo.com/en/doTrackShipmentsAction`, the read the tracking page's script makes. It asks
   for an international air waybill (`MAWB`) first and, when the tracker knows none, for a Brazilian
   domestic service order (`SO`): each type finds only its own documents.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more. The first try gets
   half of the budget.

- No session, token or CAPTCHA.
- The reply is the page's tracking tab in ISO-8859-1. Its heading must name the document asked.
- The tracker's whole answer "No result found for the given input…" for both types is read as not
  found. A block page or HTTP 403 is a challenge, HTTP 429 a rate limit, and a reply without the
  tracking tab a changed one.

## Notes

- The event table gives each event's Cargo-IMP code, or a code of its own for a hold, beside its
  description; the code sets the stage. Each event keeps its station's airport code as its place.
- Times are each station's wall clock without a zone, and LATAM's stations span several zones. They
  are kept in `local_time`, in the order the table lists them, newest first.
- The table can list a flight's departure after the delivery it led to. A delivery at the
  destination stays the current status once its rows cover all of the shipment's pieces; until
  then delivery rows read as transit.
- The delivery row's last column names who received the goods. It is never read. The route,
  pieces, weight, flight plan, delivery commitment and CT-e downloads are not read either.

## Limitations

- No public page lists LATAM Cargo's event codes: one missing from [`statuses.json`](statuses.json)
  is read by the shared wording rules on its description.
- An international air waybill has no public sample yet; its reply is assumed to share the domestic
  tab's layout, which the page's script renders for both types.

## Numbers

An air waybill or service order is a three-digit airline prefix and an eight-digit serial ending in
a mod-7 check digit. Other airlines' air waybills share that shape, so detection has no rule; select
LATAM Cargo explicitly. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page fills its form from `docPrefix`, `docNumber` and `soType` in its address. A link
needs the waybill split into its prefix and serial, so the catalog sends people to the tracking page.

## Testing

`npm run test:carriers:live -- carriers/latam-cargo`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`LATAM_CARGO_TRACKING_NUMBER` tracks another number, and `LATAM_CARGO_UNKNOWN_NUMBER` another
unknown one.
