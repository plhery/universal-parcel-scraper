# JRT

Tracks shipments of JRT (厦门今日通商贸有限公司, Jinritong), a Xiamen forwarder, on its own tenant
of the Hualei (华磊) forwarder platform. The client is shared with [GZYL](../gzyl/README.md),
whose README describes the platform; this carrier keeps its host and status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `106.53.64.22:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or
browser is needed, and no portal link is published.

## Notes

- JRT's own numbers and shippers' references both find an order. Asked by reference, the result
  carries JRT's number as `canonical_tracking_number`.
- Once JRT hands a parcel over, the record's tracking number is the delivering carrier's, and
  JRT's number, which still finds the order, is in none of its fields. A lone record then answers
  a JRT number, unless it carries another JRT number. The delivering carrier's number is the
  delivery number, never the canonical one.
- JRT's interface lists no row for an order without scans, under either number. The page shows
  the platform's own row, `货物电子信息已经收到`, on the order's creation time: the order is
  registered. The platform writes that row again when the order's data goes on, as seconds after
  the departure from JRT's centre, often days later in a batch, so a parcel can list it several
  times at different clocks. Each is its own row. A later rewrite of the history can drop older
  rows.
- JRT's own rows mix Chinese and an English translation, and the map reads each one whole. The
  airport row books a flight on a day it names in both halves; [status.ts](status.ts) reads the
  day as an ellipsis, and the row shows its English without the flight, which is still to come.
  A row that only books, expects or delays a flight is a forecast: the map lists it without a
  stage, so it keeps the stage of the scan before it and decides no status.
  `已交服务商` (handed to the delivering carrier) and `货物已交机场` (handed to
  the airport) stay in transit, though their translations read "delivered".
- JRT words its arrival, its departure and the platform's own row only in Chinese. They show the
  English the platform's other tenants give them, the `english` of their entries in
  [statuses.json](statuses.json), and the map stages them by either wording. A row stored in
  Chinese is taken over by its English at the same instant and place ([identity.ts](identity.ts)).
- Lines into Europe end with DHL. After the hand-off the tracker copies DHL's rows into its own
  history, in lower case English, and the record's tracking number is DHL's. It names no
  channel, so the parcel goes to DHL when DHL's own rule claims the number whole. The line into
  Ireland ends with FedEx, whose twelve digits no rule claims alone; its product names FedEx, so
  the parcel goes to FedEx when FedEx's detection offers the number. DHL's collection after the
  hand-off is transit, and its rows of a
  return, the refusal included, are returned: the delivery that follows is the one back to the
  sender. Its notes of the recipient's preferred location and of another address the recipient
  chose move nothing: the newest row that moves the parcel leads it.
- The line into Spain ends with CTT Express. The tracker copies CTT's pre-advice ("Pendiente de
  recepción en CTT Express") and the record's tracking number becomes CTT's reference; the parcel
  goes to CTT Express when CTT's own high-confidence rule claims it whole.
- The line into the United States ends with UPS. The tracker copies UPS's rows in Chinese, and
  they show UPS's English. They come on UPS's wall clock at the scan's place: a delivery read on
  Beijing time would fall before dawn there. Rows in UPS's words, its note that the parcel goes to
  an access point included, or at a place in the United States keep their wall clocks, which the scan's state dates, or a neighbouring scan's for a
  row without a place. The flight row names its month and day, read as an ellipsis.
- USPS's rows for the partner that carries the parcel before USPS has it ("Departed Shipping Partner
  Facility, USPS Awaiting Item") can also come as the status and, after an arrow, USPS's sentence
  naming the time, day and town. The status before the arrow decides the stage, a round's delivery
  window read as an ellipsis. USPS's acceptance after the partner's rows carries the parcel on, since
  JRT accepted it in China. The tracker dates
  that row an hour early beside the partner's own row at the same minute, so it is dated at the time
  and day the sentence names, on its state's clock.
- USPS's own scans can come three times: under the place with the country's code after it, seconds
  after the scan; under the place alone at the scan's second; and under the place alone an hour
  early, as the status alone or with USPS's sentence. Each scan is kept once, on its clock, the copy
  under the place alone when one comes at that clock. Where every copy under the place alone came an
  hour early, as at the delivering post office, a row there with no other copy, the delivery
  included, is moved on the hour too: its state's main zone would misdate a town on another clock.
- The line into the United States can end with GOFO instead. The tracker copies GOFO's scans in
  GOFO's English under the town and its state's code ("EXAMPLE TOWN,IL"), and GOFO's label
  ("Shipping Label Created") without a place, at the digits GOFO's own reply gives: a station GOFO
  dates on its zone takes that zone and the label Pacific time ([GOFO](../gofo/README.md)). A row at
  another US town and state keeps its wall clock, which the state dates. Read on Beijing time, the
  hub scan came 14 hours before GOFO's own row.
- The line into Canada ends with UniUni. The tracker copies its receipt, and the customs release
  and hand-over before it, under the town and its province's code ("Example Town ON"), on the wall
  clock there: read on Beijing time, UniUni's receipt came 13 hours before UniUni's own row at the
  same minute and second. A row at a Canadian town and its province's code is read on that
  province's clock; a row at the country alone stays on the platform's.
- The line into Mexico ends with J&T Express Mexico. The tracker copies J&T's rows in Spanish, the
  town and the site in brackets, on J&T's clock in Mexico City, the one its own tracker answers on:
  read on Beijing time, the night's sorting at J&T's centre would fall in the morning. The map reads
  their towns and sites, and the courier and phone of the collection and of the round to the
  recipient's home, as ellipses; J&T's collection of the cleared parcel is in transit.
- When an order moves to a delivery carrier's channel, the tracker can drop JRT's rows for that
  carrier's, which it has none of until the carrier scans. The lookup then has no history, and
  its error names the hand-over as a result would (`deliveryCarrier`, `deliveryTrackingNumber`).
- On the line into Europe the tracker also copies DHL's rows, in DHL's own English sentences or
  its lower case event texts ("loaded to movement / tour vehicle"). They come on DHL's wall clock
  where it scanned the parcel, the wall clocks DHL's own reply gives. A row at a town, as "hagen",
  is read on that town's clock. Without one, or beside a country's code, which names no town,
  DHL's rows from Germany (the sender's data, the transport to DHL, the parcel centre of origin, the export centre, the
  transport abroad) are read on DHL's German clock, and the others on the destination's. Read on
  Beijing time, each would sit six to eight hours before DHL's own row and show twice; a row stored
  that way is taken over by the same row on its wall clock. A help link DHL adds to a row is left
  out of its text. The tracker writes the country's code in lower case ("de"); it is shown in upper
  case, as other places name a country, and a row stored beside the lower case is taken over.
- DHL loads a parcel "to movement / tour vehicle" for a trunk run as for its round. Straight after
  the destination parcel centre it is the round, out for delivery, unless the record holds DHL's
  export rows: that centre is then the export centre in Germany, and the vehicle crosses the border.
- Other scan times are wall clocks without an offset on the platform's Beijing clock, as
  [GZYL's](../gzyl/README.md) are, and are read on it; a row dated after the lookup is held back.

## Limitations

A reference stored without its dashes is not found. A wording the map does not hold falls back to
the shared wording rules. The rows the tracker copies from FedEx, at a place such as "DUIVEN, GL, NL", are
read on the platform's clock: no FedEx reply has shown which clock they are on. Before the hand-off the record has no DHL number, so DHL's own tracker
cannot follow the parcel yet.

## Numbers

JRT's own numbers are JRT, ten digits and MM, made by a Hualei number rule; JRT is 今日通's
initials. A number typed with a letter O after JRT reads as JRT's: the tracker knows it only
without the O, and `normalizeTrackingNumber` drops it. A letter O among the ten digits is a zero
typed as a letter, and reads as one. The tracker also accepts the customer's reference, which the shipper chooses. References
made of UP and sixteen digits find JRT orders, but nothing shows that only JRT's shippers use the
shape, so `jrt-2` offers them with low confidence and recognition asks the tracker, which must
hold the whole reference. No public number of either shape has been found, so the corpus holds
synthetic ones.

## Testing

`npm run test:carriers:live -- carriers/jrt`, with `JRT_TRACKING_NUMBER` and optionally
`JRT_UNKNOWN_NUMBER` set outside the repository.
