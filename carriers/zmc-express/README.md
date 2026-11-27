# ZMC Express

ZMC Express is a courier and freight company founded in Iraq, with branches across Iraq and offices
in the United Arab Emirates, Oman, Turkey and Lebanon. It carries door-to-door and cash-on-delivery
parcels, and freight from China and Dubai to Iraq. Its tracker follows a shipment by its reference
number.

## How it works

1. `direct`: one `GET https://apps.zmc-iraq.com/getTrack1.php?cusRef={reference}&source=system&random={token}`,
   as the pop-up form on `apps.zmc-iraq.com/tracking.php` sends it, with twenty random letters and
   digits as the token. It needs no cookie, session or check.
2. `retry`: a read that fails to reach the lookup, or hangs, is sent once more.

- The lookup answers JSON labelled as HTML, one row per scan, newest first. A reference it holds
  no shipment under gets the body `error` alone, with HTTP 200. An empty body, an empty list or any
  other reply is a changed tracker, not a missing shipment.
- The lookup's answer is cached for ten minutes by its address, so each read sends a new token, as
  the page does.
- Each row's `CustomerRefNo` joins the shipment's references with ` | `, and the lookup finds the
  shipment by either. Every row must name the whole reference asked as one of them, and all rows
  the same shipment.

## Notes

- The tracker matches a reference whole, hyphens included: without them it finds nothing.
  `carrierTrackingNumber()` keeps the hyphens when ZMC Express is the carrier. The lookup finds a
  reference whatever its case.
- A status carries a detail after ` => ` or ` | `. The warehouse that received the parcel becomes
  the scan's place; a flight, a truck trip, a country or a reason stays in the wording. The status
  code is the scan's code, and the map reads it.
- The times are wall clocks with no zone. A warehouse in China is on China's clock. A warehouse in
  Iraq and a row that names Iraq are on Iraq's, and the other rows on ZMC Express's own, Iraq's.
  Dubai's warehouse keeps that clock too: its branch's customs row minutes before names no place,
  and read on two clocks the pair would swap. Each scan keeps its wall clock and names its zone and
  why.
- Rows are ordered by their wall clocks, as the tracker orders them. A status saved again within a
  minute, as a delivery saved twice, is one scan.
- `Pending delivery` follows a round on the vehicle that delivered nothing, with the reason after
  it, and reads as a failed attempt.
- The recipient's name and phone on every row, the destination town, the pieces and boxes and the
  shipment's other reference are not kept. The weight is.

## Limitations

- The tracking page reads fields the lookup no longer sends and shows no history.
- A reference stored without its hyphens is not found.
- No delivery estimate, proof of delivery or signatory.

## Numbers

References are letters and digits in parts joined by hyphens. One public sample is known, too
few to tell ZMC Express's own layout, so no rule claims them. The sample and its source are in
[`numbers.json`](numbers.json).

## Links

The tracker asks for the number in a pop-up and answers in place, so there are no tracking links.

## Testing

`npm run test:carriers:live -- carriers/zmc-express`, with `ZMC_EXPRESS_TRACKING_NUMBER` and
`ZMC_EXPRESS_UNKNOWN_NUMBER` optionally set.
