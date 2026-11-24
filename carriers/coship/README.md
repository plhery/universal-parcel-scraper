# COSHIP

COSHIP is the brand of Canada Orient Shipping Ltd. in Canada and 캐나다쉬핑 in Korea. It carries
air courier parcels between Canada and Korea, delivers them itself around Vancouver and Toronto and
hands the others to UPS, Canada Post or Korea Post. Its site is coship.ca.

## How it works

1. `direct`: reads `GET www.coship.ca/api/tracking/<number>`, as the tracking page's script does.
   The reply lists the parcel's waybill and its rows, oldest first, each with a code, a step, a day
   or wall clock and a place.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more. The first try gets
   half of the budget.

- No session, key or CAPTCHA.
- The reply must name the number asked as the waybill; another shipment's reply leaves the answer
  open.
- A number the tracker holds nothing under gets one blank record with HTTP 200, read as not found.
  The reply does not repeat the number; the request for it does. A block page is a challenge, a
  redirect or a missing route a moved tracker, and a reply of another shape a changed one.
- Numbers starting with `COS` belong to ocean shipments, which the page answers itself without
  asking the tracker: COSHIP reports their steps by email. The adapter leaves them open without a
  request.

## Notes

- COSHIP's own rows cover its Vancouver warehouse, the flight and the arrival. For parcels to
  Korea, Korean customs' rows and Korea Post's delivery rows follow in the same list, staged by
  their whole step in [`statuses.json`](statuses.json). A step missing from it is read by the
  shared wording rules.
- Rows give a day, or a wall clock without a zone, and span Vancouver and Korea. They are kept in
  `local_time`.
- Korea Post's delivery row names who took the parcel, and its delivery round row names the
  postman; both are cut from the step. The recipient's name and address, the contents, the item
  count, the order number, the memo and the service notes are never read.
- The parcels to Korea seen are numbered in Korea Post's thirteen-digit domestic range, on a Korea
  Post label COSHIP prints. The reply does not name Korea Post, so no delivery carrier is set.

## Limitations

- Older parcels keep only COSHIP's own rows: the public samples' customs and Korea Post rows are
  gone, so they end at Incheon airport.
- No estimate, and no offsets.

## Numbers

The adapter takes 6 to 30 letters and digits with at least one digit, in capitals. The numbers seen
share Korea Post's domestic range, so detection has no rule for COSHIP. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

`www.coship.ca/tracking/?no=<number>` opens the tracking page and looks the number up.

## Testing

`npm run test:carriers:live -- carriers/coship`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`COSHIP_TRACKING_NUMBER` tracks another number, and `COSHIP_UNKNOWN_NUMBER` another unknown one.
