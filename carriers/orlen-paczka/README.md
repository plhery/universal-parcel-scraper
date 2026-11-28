# ORLEN Paczka

Tracks parcels of ORLEN Paczka, the Polish pickup point and locker network formerly called
Paczka w RUCHu, through the status service its own tracking page calls.

## How it works

One anonymous GET to `https://nadaj.orlenpaczka.pl/parcel/api-status?id={number}` returns the
parcel's scans as JSON wrapped in `callback(...)`, the JSONP call the tracking page's script
(`track.dist.js` on `www.orlenpaczka.pl/sledz-paczke/`) makes. No session, cookie, key or
browser is needed.

The reply must name the requested number as the number asked about and as the parcel
(`truckNo`). Absence is the service's own placeholder: no parcel (`Brak danych`) and no scans.
Error 1004, which some numbers of the issued range return, leaves tracking inconclusive
(`tracking_withheld`): the tracker shows them as untrackable, as it does a number it has no
data for. The service gives it only to a number with its own check digit in the issued range;
the same digits with another check digit, or a number past the range, get the no-data
placeholder. So ORLEN holds a number it answers 1004, and HTTP recognition, which makes the
same lookup, reads it as known without an activity time. The tracker's notice gives a wrong
number, a parcel already collected, or an Allegro Delivery parcel, which Allegro tracks, as the
causes; Allegro's tracking service answers no scans for ORLEN's own numbers, so the adapter
has nothing to hand such a number to.

The official app (`pl.orlen.paczka`) offers no other anonymous route. It reads parcels from
`orlenapm.azure-api.net/CustomerAPP2026/v1` under `customers/{id}/shipments`, with a token its
bundled client obtains, and a customer id comes only from a phone number confirmed by an SMS
code. Its `api.orlenpaczka.pl/CMA` service serves pickup points.

## Numbers

Lookups archived from the tracker since 2021 show thirteen digits starting `210` and ending in
a GS1 check digit, the series rising over time. `orlen-paczka-1` suggests ORLEN Paczka for that
layout at low confidence, because several carriers match thirteen digits broadly. Delovye
Linii's numbers can start `210` too, but none archived passes the check, so a passing check
digit puts ORLEN Paczka first wherever the parcel comes from. The adapter takes
thirteen characters starting `2` or `3`, as the tracker's script does, and rejects a `210`
number whose check digit fails. The script also takes seven- and ten-digit sending codes,
the sender's drop-off codes rather than parcel numbers; the adapter does not look them up.
Parcels sent through Allegro Delivery, numbered from `AD`, are tracked at Allegro.

## Notes

Scan clocks are Polish wall time without an offset. They are read in `Europe/Warsaw`: every
scan comes from a point or sorting centre of the Polish network, and the service stamps its
own current time in that zone. A wall clock the zone repeats or skips stays local.

Each scan has a numeric code, a short category and a sentence. The sentence is kept as the
scan's wording and the code sets its stage; parcels of some services carry an older sentence
for the same code. A parcel handed to another country's carrier arrives under the code and
category of a parcel waiting at its point, so that wording, or a shorter one saying the parcel
is in another country, keeps it in transit. Code 1200, a collected return parcel, ends a
customer's return at the merchant's warehouse: ORLEN's
[API documentation](https://www.orlenpaczka.pl/wp-content/uploads/2026/08/API_ORLENPaczka_v_1_26_004_ENG.pdf)
gives it only to returns to the sender's warehouse, so it reads as returned under the same short
category as a recipient's collection. The town a
sorting-centre scan names becomes its location. A code the map does not know keeps its
wording without a stage. When the reply says its history is not `full`, the official page
shows the newest scan alone and the result is marked partial.

## Limitations

The reply has no pickup point, recipient, sender, weight or delivery estimate. It can name a
return parcel under a number of its own, which the adapter does not follow. The site's firewall
can refuse a request with an HTML page, which is read as a challenge, not a missing parcel.
Delivered parcels drop out of the tracker after some months.

## Links

ORLEN Paczka's tracker opens one parcel at `www.orlenpaczka.pl/sledz-paczke/?numer={number}`,
the address its copy-link button builds and the shape of the archived lookups.

## Live test

Set `ORLEN_PACZKA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/orlen-paczka/adapter.live.test.ts`.
Optionally set `ORLEN_PACZKA_UNKNOWN_NUMBER` to check an absent parcel.
