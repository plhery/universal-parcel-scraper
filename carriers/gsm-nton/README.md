# GSM NtoN

GSM NtoN (Global Shipping Master NtoN) carries parcels into Korea by air and sea for overseas
shops, and hands them to a Korean carrier for delivery. Its site's tracking form opens the bill on
expressWeb, the tracker a number of Korean forwarders share, which takes the house bill number.

## How it works

1. `direct`: posts to expressWeb's three services as its tracing page does:
   `selectGetTrackingBound.do` for the bill's bound (air or ocean, import or export), then
   `selectTracingObjByLogin.do` for its header and `selectTracingListByLogin.do` for its rows,
   from the tables that bound names. The first reply opens a session the later requests carry.
   The bound's `{"data":"null"}` is not found.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- [`expressweb.ts`](expressweb.ts) and [`parser.ts`](parser.ts) take the forwarder code, so another
  expressWeb forwarder needs only its own tenant.
- The tracing page itself is not needed: the services answer without it.
- The event list takes the keys as plain form fields, with the header's reference; sent as
  `params`, as the other two take them, it fails with HTTP 500.
- A header or bound must name the number asked.
- expressWeb answers plain HTTP only, so no portal link is published; the link rule still reads
  its tracing links under GSM NtoN's forwarder code.

## Notes

- Rows are read in English; the Korean and Chinese wordings carry the same codes.
- Rows keep their wall clock: the tracker gives no zone, and its rows come from the station abroad
  as well as from Korea. A departure or arrival names its airport or port, and a Korea Post scan
  its post office; other rows have no place.
- An import's destination is Korea.
- The delivering carrier comes from the header's delivery code: the bill number is that carrier's
  number, unless the delivery was changed to another number. A delivery split between several
  numbers names none of them.
- The consignee, shipper, weight, order number and remarks stay behind; a Korea Post remark also
  names the recipient and the postman.

## Limitations

- No delivery estimate or proof of delivery.
- Only the first hundred rows of a bill are read.

## Numbers

A bill is usually the delivering carrier's number. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/gsm-nton`

The live test tracks the public sample in `numbers.json`; `GSM_NTON_TRACKING_NUMBER` tracks another
bill, and `GSM_NTON_UNKNOWN_NUMBER` checks the not-found answer.
