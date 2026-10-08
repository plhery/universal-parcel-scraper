# OnTrac

Tracks OnTrac and LaserShip parcels through the JSON endpoint used by the official website.

## How it works

One anonymous GET returns packages and scans. Exactly one returned tracking identifier must
match the request. A generic missing-resource problem response cannot distinguish an
unknown parcel from an unavailable endpoint, so it remains inconclusive. An empty or
mismatched package list is inconclusive or a schema failure.

The `C` and `D` number families select OnTrac when the last digit matches UPS's `1Z`
check, with C counted as 4 and D as 5. Nearly every number archived from OnTrac's tracker
passes it, and no other carrier's rule takes the shape; a number that fails it is not
offered. HTTP recognition requires matching shipment scans; an unavailable tracking
resource remains a failed probe.

## Notes

The endpoint's newest-first order is preserved, including scans without offsets. Valid
offset-less clocks remain local wall times; invalid dates retain their text on an undated event. Incomplete
scan rows fail the lookup so older progress cannot appear current. Each
scan uses its own regional status code; unfamiliar codes keep their wording for review.
The parser reads short scan descriptions and city/state, the weight and the parcel's
sides in OnTrac's unit, excluding recipient details, references, signatures and
proof-of-delivery images. The hold code asking the recipient for address details or
instructions is an exception; a delivery stopped for missing address details is a failed
attempt.

## Testing

`npm run test:carriers:live -- carriers/ontrac`. Set
`ONTRAC_TRACKING_NUMBER` to check history for an authorized real parcel.
