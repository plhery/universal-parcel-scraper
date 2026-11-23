# Air Arabia Cargo

Air Arabia Cargo carries freight on the Air Arabia group's flights. Select Air Arabia Cargo and enter a full master air waybill or an Air Arabia serial of eight digits; the serial's last digit is its check digit. The tracker reads waybills of Air Arabia (`514`), Air Arabia Abu Dhabi (`049`), Air Arabia Maroc (`452`), Air Arabia Egypt (`844`) and Fly Jinnah (`772`).

## How it works

1. `direct`: the [public tracking page](https://cargo.airarabia.com/cargo-tracking/) asks the group's iCargo tracking API for the waybill under the airline's own path, with the key the page sends for every visitor.

## Notes

- The API answers an unknown waybill with HTTP 400 and the code `ICO_TRK_001`; any other code is a refused request, not a missing shipment.
- Each record carries its station's offset, so events keep the instant the carrier states.
- The history comes oldest first and repeats some records. The adapter drops exact repeats and a booking saved again with the same flight, station and pieces, then lists the newest first.
- A booking after the acceptance or a move keeps the stage before it.
- A delivery completes the waybill once every stated piece is delivered at the destination.
- The page also lists Fly Arna (`253`), but the API refuses the page's key for it.

## Limitations

- Flight numbers stay in the event wording. Pieces, weights, ULDs and planned flight times are not returned as fields.
- The public sample is an Air Arabia waybill. The other group airlines' paths are checked only with an unknown waybill, which they answer as not found.

## Testing

```sh
AIR_ARABIA_CARGO_TRACKING_NUMBER=… AIR_ARABIA_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/air-arabia-cargo
```
