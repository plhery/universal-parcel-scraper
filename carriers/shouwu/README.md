# Shouwu International

Shouwu International is 上海守务国际, a Shanghai cross-border forwarder. Universal providers name
it SWE. The adapter reads the lookup its tracking page asks.

## Numbers

Its waybills are SWECN, twelve digits and YQ. The twelve digits open with the date. A parcel a
universal provider filed under SWE has that layout and Shouwu's own tracker answers it, and no
other carrier's rule takes it, so `shouwu-1` has high confidence.

## Retrieval

The tracking page's script asks `POST
https://admin.shshouwu.com/api/freight/order/PubOrder/getOrderTrace` with `{"strs":[number]}`,
without a cookie, account or CAPTCHA, and the adapter sends the same request. One HTTP read, and
one more when the first fails to connect or hangs. Recognition makes the same lookup for the
numbers `shouwu-1` offers.

## Notes

- The lookup answers with HTTP 200 and `{"result":{"code":0},"data":[…]}`, one entry per parcel
  it has under the numbers asked. A number without an entry is what the page shows as not
  found, and the only not-found. Another code, as for a request it cannot read, is
  inconclusive; a redirect, a 404, a browser check or a reply that is not JSON is never read as
  a missing parcel.
- Only entries whose `order.orderNo` is the whole number asked are read. A reply naming another
  number only is inconclusive. The page lists every entry under a number; of two, the one with
  the newest scan is read.
- `order.traceStatus` is one of four codes the page labels Preparing, In Transit, Undelivered
  and Delivered. It decides the stage, as on the page. The page explains Preparing as a parcel
  at the warehouse and In Transit as anything from the handover to delivery in the destination
  country, so the newest staged scan refines a status within what it covers. A status without
  scans is a summary. Scans have no code; the status map stages the wording seen on them, such as
  the warehouse's intake and processing as accepted, and the shared rules stage the rest.
  Colis Privé's relayed notices that its partner has the parcel, or carries it there, come beside
  that intake, before the parcel leaves the warehouse, and are accepted too. On
  some lines Shouwu writes its own rows in Chinese, through the flight and the clearance abroad;
  the delivering partner's "Your consignment has been picked up", or FedEx's "Picked up", after
  them is that partner collecting the parcel from Shouwu's depot, in transit, not a handover from
  the sender. A last mile's "STATIONED SHIPMENT" and "STATIONED LOCATED" after its failed
  delivery, or their Spanish "Envío estacionado" and "Estacionado ubicado", its station keeping
  the parcel, say neither that it waits for collection nor that another round follows, so they
  name no stage. The flight booked for the parcel ("Estimated time of take-off", "Scheduled
  flights", or Shouwu's own row naming the flight's day) is a forecast written before it flies, a
  notice on the stage of the scan before it.
- A delivery after a row that sends the parcel back, as DHL's "Shipment sent directly from parcel
  center to business customer" after its "Shipment will be returned to origin", is the return
  delivered to the sender: returned, which refines Undelivered and Delivered alike.
- Shouwu writes "Carrier received the shipment" two hours to the second after the order data, and
  the page's status turns In Transit with it, days before the first facility scan. The row is
  part of the registration, and In Transit on registration rows alone stays registered. Written a
  day or more after the order data, the same row is the handover itself, an acceptance, which the
  first movement follows within a day.
- Without such a receipt, the first "Shipment arrived at a carrier facility" right after the
  registration is the acceptance; later ones are on the way.
- `traceTime` is epoch seconds, which the page shows in the visitor's zone without naming one.
  Shouwu's back office reads every scan's wall clock on Beijing time, a scan abroad's too, so a
  flight out of Shanghai reads hours shorter than it is. Each scan keeps the wall clock its epoch
  shows in Beijing as `local_time`, which Node lookups date on its place's zone; a scan in China
  keeps the epoch's instant. A scan stored from the epoch as its instant is taken over by its
  wording and place (`identity.ts`). The page reads the first ten digits, so the adapter reads
  milliseconds as the same second.
- Some rows abroad are the epoch's instant: iMile's rows in Italy (its 【centre】 sentences and a
  missed delivery's `<reason>` under the country's code) and an agent's own flight, clearance and
  hand-over rows under an airport's code in the agent's feed (`TRACE_TYPE_TAIL`). Their write time
  (`createTs`) falls minutes or a few hours after the epoch, hours before their place's clock
  would put them. The notes an agent writes in Chinese under the destination's code, as a delay at
  a Chinese port filed under GB, are written in China and read the same way. These rows give
  `time` on Beijing's clock. The airline's rows under an airport's code (`TRACE_TYPE_HEAD`) and the
  delivering partners' rows are wall clocks: a flight from Shanghai to Amsterdam would otherwise
  last five hours, and La Poste's and DHL's rounds would start at night.
- The Spanish last mile's rows in the agent's feed, in capitals and without a place, as "IN
  DELIVERY", carry UTC's wall clock, which went into the back office as Beijing's: its manifest
  record comes eight hours to the second before Shouwu's receipt of the order data. They give
  `time` on UTC's clock. Stored rows keep their identity by the wall clock.
- A row under a country's code or without a place is the epoch's instant too when Shouwu wrote it
  (`createTs`) before the earliest instant its Beijing wall clock stands for anywhere in that
  country, or in the destination: a flight's arrival under US, written five hours after its
  epoch, would otherwise have landed thirteen hours after it. A code that names no country, as
  EU, stands for the destination: customs under EU read on Vienna's clock would have come after
  Shouwu wrote it. A row written later keeps its wall
  clock, unless even the earliest instant it stands for there comes after a newer row read at its
  epoch: customs written days late is then read at its epoch, not after the round out for
  delivery.
- A scan's place is `traceLocation`, which the page leaves out and Shouwu's own back office shows
  before the wording. A country's code it opens with, as in `CN,` before a sort facility, is left
  out, and so is the empty one, the bare comma, before a last mile's town. Anything with a digit, as an address or a postcode has, is dropped.
- FedEx's rows in the United States open their wording with the town, state, country and
  postcode (`SAMPLE TOWN, CA, US, 00000, Arrived at FedEx location`), a delivery's the
  recipient's. The wording is read without them, as the place is `traceLocation`, and a row
  stored with them keeps its identity.
- On the line into Europe, Shouwu writes a milestone's title and then its description, which can
  be the same words ("Out for delivery Out for delivery"), and a last mile's note can repeat its
  scan ("Delivery failed, Carrier note: Delivery failed"). Such wording is read once, and a row
  stored with it said twice keeps its identity.
- A last mile's notice can name the recipient's e-mail address, as DPD's "Predict information sent
  to: …". Results drop it, as they do for every carrier.
- The destination is `order.countryCodeTwo`. The status text (`traceStatusDesc`) and the
  destination's name are not read.
- The request carries the page's `x-locale`, `zh-cn` unless a visitor chose another language.

## Limitations

- No estimate, weight, service, last-mile carrier or last-mile number: the page shows none.
- No delivery instant: scans give wall clocks in no stated zone.

## Links

`admin.shshouwu.com/track.html?q=` followed by the number opens a parcel. The customer portal on
sedel.com sends its tracking box there.

## Testing

Set `SHOUWU_TRACKING_NUMBER` to a waybill and optionally `SHOUWU_UNKNOWN_NUMBER` outside the
repository, then run `npm run test:carriers:live -- carriers/shouwu`.
