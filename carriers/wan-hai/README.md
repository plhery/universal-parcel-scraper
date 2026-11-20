# Wan Hai

Wan Hai Lines is the Taiwanese container line. Tracked through the cargo tracking service of its
Android app, WanTouch, for a booking, a bill of lading or a container.

## How it works

1. `direct` asks the app's service at `https://whlapiv2.wanhai.com/shipping/rest/eshipping/skd/cargo-tracking`
   as the app does:
   - a booking or bill: its B/L screen, `bl-detail?ref_no=`, or its booking screen,
     `booking-detail?ref_no=`, when no bill is issued yet; then the moves of its first three
     containers, `movement?ref_no=&ctnr_no=`;
   - a container: its screen, `ctnr-no?ctnr_no=`, which names the booking of its latest cycle;
     then its moves under that booking.
2. `retry` asks once more when a request did not reach Wan Hai.

The website's tracker, `www.wanhai.com/views/cargoTrack/CargoTrack.xhtml`, sits behind Imperva,
which answers with an hCaptcha picture challenge. The app's service is not behind it. It asks
for the app's headers: a key that is the same in every copy of the app, its version and device
fields, which describe no particular device. No account, cookie or CAPTCHA is needed.

## Notes

- A reply must succeed and name the number asked. A screen without containers, or a container
  screen without a booking, is a number Wan Hai does not hold. A booking listed without
  containers, or containers without moves, is no history.
- The return of the empty container is the delivery, and a full container withdrawn by the
  consignee goes out for delivery. An empty container returned before it moved is an unused one,
  and a gate in after the container moved is transit. The wordings are staged in
  [statuses.json](statuses.json).
- A bill's containers move apart. The bill is delivered once every container is back; until then
  the latest open stage leads. The containers past the first three keep the latest status of the
  B/L screen, and the history is marked truncated.
- Times are wall clocks. A facility whose name holds a town of the route, from its place of
  receipt to its place of delivery, is read in that town's zone: a US state's or Canadian
  province's from the code after the town, or the country's. Other times, and all of a container
  lookup's, keep their wall clock.
- Estimated dates, vessels, voyages, weights and seals are not read.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.
- The app's search screen, `bl-no`, says a bill's details are gone 90 days after loading, but the
  B/L screen still answers for older bills. A bill whose booking has another number than the bill
  is asked by the bill's own number.

## Numbers

Bookings and bills are three digits for the issuing office, a letter, a letter or digit and five
digits. Import records put Wan Hai's SCAC, `WHLC`, before them, which the adapter drops.
Containers are ISO 6346 numbers, whose check digit is checked before the lookup. Detection has no
rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/wan-hai`, with `WAN_HAI_TRACKING_NUMBER` and
`WAN_HAI_UNKNOWN_NUMBER` set outside the repository.
