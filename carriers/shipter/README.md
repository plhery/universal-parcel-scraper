# Shipter

Tracks Shipter's own H3 shipment numbers through its ordinary guest service. A delivery
carrier's reference is not a Shipter identifier and does not establish a delivery handoff.

## How it works

`direct` sends one JSON POST to `https://shiptertracking.com:3963/tracking/getTracks`, with
`trackNos` containing the whole requested number. The [official tracking page](https://www.shipter.kr/tracking)
uses this service without an account or session. A successful reply must identify the number
as `in_track_no` in the service's `result` list. `retry` repeats the read once only after a
network failure, within the same budget.

The separate `deliveries: []` and `err: "no result"` envelope confirms absence. An empty
success list, another error, or an expired reply does not. Blocks and malformed replies stop
the lookup.

## Limitations

Event clocks preserve their stated GMT offsets. A clock without an offset keeps its wall
time. The timeline supplies the latest activity and delivery time; refresh and summary
clocks can disagree with it. A summary without scans, a conflicting delivery summary or a
capped history stays partial so an enabled provider can complete it. Combined partner labels
remain unattributed, and partner references never become canonical Shipter numbers.

## Testing

`npm run test:carriers:live -- carriers/shipter`, with `SHIPTER_TRACKING_NUMBER` and optionally
`SHIPTER_UNKNOWN_NUMBER` set outside the repository.
