# China Airlines Cargo

China Airlines Cargo is the air freight service of Taiwan's China Airlines. Select China Airlines Cargo and enter a full `297` master air waybill or its eight-digit serial; the serial's last digit is its check digit.

## How it works

1. `direct`: the [public iCargo portal](https://icargowebportal.china-airlines.com/icargoneoportal/app/main/#/app/tracking/awb) signs in as an anonymous guest through its GraphQL gateway, then asks for the waybill's summary and its activity with the portal's own named operations. The adapter sends the guest token as a bearer header.

The portal's client and reading live in [icargoNeo.ts](icargoNeo.ts), which SriLankan Cargo shares.

## Notes

- The gateway answers only the portal's operation names; any other name is refused as not signed in.
- The activity query can take several seconds for a long history, so the adapter allows 20 seconds.
- The activity list comes newest first on each station's wall clock, without an offset. The adapter keeps that order, the local times and the airport codes.
- Like the portal, an arrival or departure counts once per flight. Rows with one code at one station and minute, such as bookings for each leg, become one event naming their flights.
- The tracker books and rebooks later legs while the goods travel. A booking after the acceptance or a move keeps the stage before it.
- A delivery completes the waybill once the tracker's delivered milestone is done or every piece is delivered at the destination.
- The index form on cargo.china-airlines.com shows an image CAPTCHA, but it only hands the number over to this portal, which asks for none.

## Limitations

- Flight numbers stay in the event wording. The pieces, weights, ULDs and routing are not returned as fields.
- The portal's shipper and consignee queries are not used.

## Testing

```sh
CHINA_AIRLINES_CARGO_TRACKING_NUMBER=… CHINA_AIRLINES_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/china-airlines-cargo
```
