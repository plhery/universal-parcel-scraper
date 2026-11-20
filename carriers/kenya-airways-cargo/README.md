# Kenya Airways Cargo

Select Kenya Airways Cargo explicitly and enter the master air waybill with its 706 prefix. The [guest cargo tracker](https://cargotrack.kenya-airways.com/) uses the prefix and the eight-digit serial.

## Retrieval

The adapter submits the guest request and checks the full air waybill on the result. It associates the milestone list with that result through the matching eight-digit serial. The history preserves each milestone's recorded time and station. Flight times and the separate warehouse notes are omitted.

Booking confirmation, acceptance and departure describe different steps. A flight manifest records an assignment and stays unstaged on its own.

## Testing

`KENYA_AIRWAYS_CARGO_TRACKING_NUMBER=… KENYA_AIRWAYS_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/kenya-airways-cargo`
